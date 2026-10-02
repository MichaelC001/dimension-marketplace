/**
 * The Browser View's direct channel (doc 77 §3): one loopback listener that streams a browser's live pictures and
 * state out, and takes the human's mouse and keys in, so neither rides the MCP tool-call lane.
 *
 *   GET  /s/<token>[?frames=0]   pictures (JPEG) and state, framed by wire.ts; `frames=0`: state only
 *   POST /i/<token>              one batch of input events (JSON), answered { ok } or { ok: false, code, error }
 *
 * The listener exists only while a View holds a token: it opens on the first `mint`, and closes with the last token. A token names ONE
 * browser (never a session, never another browser) and dies with its browser, after an idle limit, or with the pack. The token is the
 * credential; the Host and Origin checks keep a web page that resolves to 127.0.0.1, or any real origin, out even if it knew one.
 */
import { randomBytes } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import type { BrowserState } from "./contracts.js";
import type { LiveFrame } from "./engines/types.js";
import { BrowserRuntimeError } from "./store.js";
import { encode, KIND_PICTURE, KIND_STATE } from "./wire.js";

/** What the channel needs of the runtime. The runtime's own `watchFrames`, `liveState` and `input` are exactly these. */
export interface LiveSource {
	/** Pictures of the browser's active tab until the returned function is called. Throws `unknown_browser`. */
	watchFrames(browserId: string, onFrame: (frame: LiveFrame) => void): () => void;
	/** The browser's state, not queued behind page work. Throws `unknown_browser` once it is closed. */
	liveState(browserId: string): Promise<BrowserState>;
	/** A View is joined to this browser's stream until the returned function is called: the runtime does not give a watched browser up. Throws `unknown_browser`. */
	viewing(browserId: string): () => void;
	/** One batch of the human's input. Rejects with a `BrowserRuntimeError` whose `code` says why. */
	input(browserId: string, events: unknown): Promise<void>;
}

export interface LiveChannelOptions {
	/** A token with no open stream and no input for this long is dropped. */
	tokenIdleMs?: number;
	/** How often a browser's state is read while a View watches. */
	stateIntervalMs?: number;
	/** The most live tokens one browser holds; minting past it drops the oldest. */
	maxTokensPerBrowser?: number;
}

const TOKEN_IDLE_MS = 60_000;
const STATE_INTERVAL_MS = 250;
const MAX_TOKENS_PER_BROWSER = 16;
/** One input batch is at most 64 small events plus a 4 KiB paste; a body past this is not one. */
const MAX_BODY_BYTES = 256 * 1024;
/** A hostile body is read (so the answer reaches the sender) only up to here, then the connection is cut. */
const MAX_DRAIN_BYTES = 8 * 1024 * 1024;
/** The runtime's codes for a browser that no longer exists. */
const GONE_CODES: ReadonlySet<string> = new Set(["unknown_browser", "browser_closed"]);
const STATUS_BY_CODE: Record<string, number> = { task_running: 409, publish_pending: 409, bad_input: 400, bad_json: 400, unknown_browser: 410, browser_closed: 410 };
/** No body, no secret: only what lets an opaque-origin View read an answer. */
const CORS = { "access-control-allow-origin": "*" } as const;

type Parts = readonly [Uint8Array, Uint8Array];

interface Grant {
	browserId: string;
	/** Epoch ms of the last stream open, stream close or input. */
	lastUsed: number;
	/** Streams open on this token. */
	open: number;
}

/** One connected View: it is given the newest of each kind, never a backlog. */
class Client {
	#busy = false;
	#state: Parts | undefined;
	#picture: Parts | undefined;

	constructor(
		readonly response: http.ServerResponse,
		readonly wantsPictures: boolean,
	) {}

	offerState(message: Parts): void {
		this.#state = message;
		this.#flush();
	}

	offerPicture(message: Parts): void {
		this.#picture = message;
		this.#flush();
	}

	end(): void {
		this.response.end();
	}

	/**
	 * Write what is waiting, unless the socket is still taking the last write (its callback has not run). While it is, a newer message
	 * REPLACES the waiting one, so a View that cannot keep up costs the pack one message beyond what the socket already holds, not a queue.
	 */
	#flush(): void {
		const { response } = this;
		if (this.#busy || response.destroyed || response.writableEnded) return;
		const chunks = [this.#state, this.#picture].flatMap((message) => (message === undefined ? [] : message.filter((part) => part.length > 0)));
		this.#state = undefined;
		this.#picture = undefined;
		if (chunks.length === 0) return;
		this.#busy = true;
		const written = (): void => {
			this.#busy = false;
			this.#flush();
		};
		response.cork();
		chunks.forEach((chunk, at) => response.write(chunk, at === chunks.length - 1 ? written : undefined));
		response.uncork();
	}
}

/** Everything the Views of one browser share: one state reader, one picture watcher, the newest of each for a View that joins later. */
class Room {
	readonly clients = new Set<Client>();
	/** What ends each joined View's hold on the browser (`LiveSource.viewing`). */
	readonly #leases = new Map<Client, () => void>();
	#stopWatching: (() => void) | undefined;
	#timer: ReturnType<typeof setInterval> | undefined;
	#sampling = false;
	#lastState: string | undefined;
	#lastPicture: Parts | undefined;

	constructor(
		readonly browserId: string,
		private readonly source: LiveSource,
		private readonly intervalMs: number,
		/** The last View left. */
		private readonly onEmpty: (room: Room) => void,
		/** The browser is closed. */
		private readonly onClosed: (room: Room) => void,
	) {}

	join(client: Client): void {
		this.clients.add(client);
		// Joined means watching: from here until it leaves, the runtime will not give this browser up.
		try {
			this.#leases.set(client, this.source.viewing(this.browserId));
		} catch (error) {
			if (!isGone(error)) throw error;
			this.onClosed(this);
			return;
		}
		this.#timer ??= setInterval(() => void this.#sample(), this.intervalMs);
		if (client.wantsPictures) this.#watch();
		if (this.#lastState !== undefined) client.offerState(encode(KIND_STATE, JSON.parse(this.#lastState)));
		else void this.#sample();
		if (client.wantsPictures && this.#lastPicture !== undefined) client.offerPicture(this.#lastPicture);
	}

	leave(client: Client): void {
		this.clients.delete(client);
		this.#leases.get(client)?.();
		this.#leases.delete(client);
		if (![...this.clients].some((other) => other.wantsPictures)) this.#unwatch();
		if (this.clients.size > 0) return;
		this.#stop();
		this.onEmpty(this);
	}

	/** The browser is gone, or the pack is stopping: every View is told by its stream ending. */
	end(): void {
		const clients = [...this.clients];
		this.clients.clear();
		for (const release of this.#leases.values()) release();
		this.#leases.clear();
		this.#stop();
		for (const client of clients) client.end();
	}

	#stop(): void {
		clearInterval(this.#timer);
		this.#timer = undefined;
		this.#unwatch();
	}

	#watch(): void {
		if (this.#stopWatching !== undefined) return;
		try {
			this.#stopWatching = this.source.watchFrames(this.browserId, (frame) => this.#picture(frame));
		} catch (error) {
			if (isGone(error)) this.onClosed(this);
		}
	}

	#unwatch(): void {
		this.#stopWatching?.();
		this.#stopWatching = undefined;
		this.#lastPicture = undefined;
	}

	#picture(frame: LiveFrame): void {
		const message = encode(KIND_PICTURE, { id: frame.id, viewport: frame.viewport, at: frame.capturedAt }, frame.jpeg);
		this.#lastPicture = message;
		for (const client of this.clients) if (client.wantsPictures) client.offerPicture(message);
	}

	/** Read the state; tell the Views only when it differs from the last they were told. */
	async #sample(): Promise<void> {
		if (this.#sampling) return;
		this.#sampling = true;
		try {
			const state = await this.source.liveState(this.browserId);
			const json = JSON.stringify(state);
			if (json === this.#lastState) return;
			this.#lastState = json;
			const message = encode(KIND_STATE, state);
			for (const client of this.clients) client.offerState(message);
		} catch (error) {
			// A page mid-navigation can fail one read; only a closed browser ends the stream.
			if (isGone(error)) this.onClosed(this);
		} finally {
			this.#sampling = false;
		}
	}
}

function isGone(error: unknown): boolean {
	return error instanceof BrowserRuntimeError && GONE_CODES.has(error.code);
}

function notFound(response: http.ServerResponse, cors: boolean): void {
	response.writeHead(404, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", ...(cors ? CORS : {}) });
	response.end("Not found.\n");
}

function reply(response: http.ServerResponse, status: number, body: unknown): void {
	response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", ...CORS });
	response.end(JSON.stringify(body));
}

export class LiveChannel {
	readonly #source: LiveSource;
	readonly #tokenIdleMs: number;
	readonly #stateIntervalMs: number;
	readonly #maxTokens: number;
	/** In minting order, so the oldest is first. */
	readonly #grants = new Map<string, Grant>();
	readonly #rooms = new Map<string, Room>();
	#server: http.Server | undefined;
	#listening: Promise<number> | undefined;
	#port = 0;
	#sweeper: ReturnType<typeof setInterval> | undefined;

	constructor(source: LiveSource, options: LiveChannelOptions = {}) {
		this.#source = source;
		this.#tokenIdleMs = options.tokenIdleMs ?? TOKEN_IDLE_MS;
		this.#stateIntervalMs = options.stateIntervalMs ?? STATE_INTERVAL_MS;
		this.#maxTokens = options.maxTokensPerBrowser ?? MAX_TOKENS_PER_BROWSER;
	}

	/** A token for one View of `browserId`, and where to find the listener. Throws `unknown_browser` when there is no such browser. */
	async mint(browserId: string): Promise<{ origin: string; token: string }> {
		await this.#source.liveState(browserId);
		const port = await this.#listen();
		const mine = [...this.#grants].filter(([, grant]) => grant.browserId === browserId);
		for (const [token] of mine.slice(0, Math.max(0, mine.length - this.#maxTokens + 1))) this.#grants.delete(token);
		const token = randomBytes(24).toString("base64url");
		this.#grants.set(token, { browserId, lastUsed: Date.now(), open: 0 });
		this.#sweeper ??= setInterval(() => this.#sweep(), Math.min(1_000, this.#tokenIdleMs));
		this.#sweeper.unref();
		return { origin: `http://127.0.0.1:${port}`, token };
	}

	/** Every stream ends, every token dies, the listener closes. */
	async close(): Promise<void> {
		for (const room of [...this.#rooms.values()]) room.end();
		this.#grants.clear();
		await this.#shutDown();
	}

	#listen(): Promise<number> {
		this.#listening ??= (async () => {
			const server = http.createServer((request, response) => void this.#handle(request, response));
			// A View's connection is a stream; Node's request timeouts are for requests, and a quiet page is a legitimate silence.
			server.requestTimeout = 0;
			server.keepAliveTimeout = 5_000;
			server.on("connection", (socket) => socket.setNoDelay(true));
			const { promise, resolve, reject } = Promise.withResolvers<void>();
			server.once("error", reject);
			server.listen(0, "127.0.0.1", resolve);
			await promise;
			this.#server = server;
			this.#port = (server.address() as AddressInfo).port;
			return this.#port;
		})();
		return this.#listening;
	}

	async #shutDown(): Promise<void> {
		clearInterval(this.#sweeper);
		this.#sweeper = undefined;
		const server = this.#server;
		this.#server = undefined;
		this.#listening = undefined;
		if (server === undefined) return;
		const closed = Promise.withResolvers<void>();
		server.close(() => closed.resolve());
		server.closeAllConnections();
		await closed.promise;
	}

	/** Drop every token that has sat idle with no stream; close the listener when none is left. */
	#sweep(): void {
		const now = Date.now();
		for (const [token, grant] of this.#grants) if (grant.open === 0 && now - grant.lastUsed > this.#tokenIdleMs) this.#grants.delete(token);
		this.#closeIfUnused();
	}

	#closeIfUnused(): void {
		if (this.#grants.size === 0) void this.#shutDown().catch(() => undefined);
	}

	/** The browser is closed: its tokens die and its streams end. */
	#revokeBrowser(browserId: string): void {
		for (const [token, grant] of this.#grants) if (grant.browserId === browserId) this.#grants.delete(token);
		const room = this.#rooms.get(browserId);
		this.#rooms.delete(browserId);
		room?.end();
		this.#closeIfUnused();
	}

	#room(browserId: string): Room {
		let room = this.#rooms.get(browserId);
		if (room === undefined) {
			room = new Room(
				browserId,
				this.#source,
				this.#stateIntervalMs,
				(empty) => {
					if (this.#rooms.get(empty.browserId) === empty) this.#rooms.delete(empty.browserId);
				},
				(closed) => this.#revokeBrowser(closed.browserId),
			);
			this.#rooms.set(browserId, room);
		}
		return room;
	}

	async #handle(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
		// Not the loopback address this listener was reached at: a name an attacker's page rebound to 127.0.0.1. No answer, no CORS header.
		if (request.headers.host !== `127.0.0.1:${this.#port}`) return notFound(response, false);
		// A sandboxed View's origin is `null`; a non-browser caller sends none. A page on a real origin is neither.
		const origin = request.headers.origin;
		if (origin !== undefined && origin !== "null") return notFound(response, false);
		const url = new URL(request.url ?? "/", `http://127.0.0.1:${this.#port}`);
		const [empty, route, token, ...more] = url.pathname.split("/");
		const grant = token === undefined ? undefined : this.#grants.get(token);
		if (empty !== "" || more.length > 0 || grant === undefined || (route !== "s" && route !== "i")) return notFound(response, true);
		if (request.method === "OPTIONS") {
			response.writeHead(204, { ...CORS, "access-control-allow-methods": "GET, POST", "access-control-allow-headers": "content-type", "access-control-allow-private-network": "true", "access-control-max-age": "600" });
			return void response.end();
		}
		if (route === "s" && request.method === "GET") return this.#stream(request, response, grant, url.searchParams.get("frames") !== "0");
		if (route === "i" && request.method === "POST") return await this.#input(request, response, grant);
		return notFound(response, true);
	}

	#stream(request: http.IncomingMessage, response: http.ServerResponse, grant: Grant, wantsPictures: boolean): void {
		grant.open += 1;
		response.writeHead(200, { ...CORS, "content-type": "application/octet-stream", "cache-control": "no-store", "x-content-type-options": "nosniff" });
		const client = new Client(response, wantsPictures);
		const room = this.#room(grant.browserId);
		let left = false;
		const leave = (): void => {
			if (left) return;
			left = true;
			grant.open -= 1;
			grant.lastUsed = Date.now();
			room.leave(client);
		};
		// Node closes the response and the request when the View goes; Bun only the request.
		request.once("close", leave);
		response.once("close", leave);
		room.join(client);
	}

	async #input(request: http.IncomingMessage, response: http.ServerResponse, grant: Grant): Promise<void> {
		grant.lastUsed = Date.now();
		const chunks: Buffer[] = [];
		let size = 0;
		for await (const chunk of request as AsyncIterable<Buffer>) {
			size += chunk.length;
			if (size > MAX_DRAIN_BYTES) return void request.destroy();
			if (size <= MAX_BODY_BYTES) chunks.push(chunk);
		}
		if (size > MAX_BODY_BYTES) return reply(response, 413, { ok: false, code: "too_large", error: `input is larger than ${MAX_BODY_BYTES} bytes` });
		let events: unknown;
		try {
			events = JSON.parse(Buffer.concat(chunks).toString("utf8"));
		} catch {
			return reply(response, 400, { ok: false, code: "bad_json", error: "input must be JSON" });
		}
		try {
			await this.#source.input(grant.browserId, events);
			reply(response, 200, { ok: true });
		} catch (error) {
			const code = error instanceof BrowserRuntimeError ? error.code : "input_failed";
			if (isGone(error)) this.#revokeBrowser(grant.browserId);
			reply(response, STATUS_BY_CODE[code] ?? 500, { ok: false, code, error: error instanceof Error ? error.message : String(error) });
		}
	}
}

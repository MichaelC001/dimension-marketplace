import { decodeFrame, encodeFrame, type TunnelFrame } from "@dimension/artifact-host/tunnel-protocol";
import type { Server, ServerWebSocket } from "bun";

export interface RelayHello {
	readonly tunnelId?: string;
	readonly token?: string;
}

export class RelayRequest {
	status: number | undefined;
	readonly chunks: Uint8Array[] = [];
	failure: string | undefined;
	readonly finished: Promise<void>;
	#settle!: () => void;
	readonly #send: (frame: TunnelFrame) => void;
	readonly #id: number;
	#granted = 0;
	overran = false;

	constructor(id: number, window: number, send: (frame: TunnelFrame) => void) {
		this.#granted = window;
		this.#id = id;
		this.#send = send;
		this.finished = new Promise<void>(resolve => {
			this.#settle = resolve;
		});
	}

	get bytes(): number {
		return this.chunks.reduce((total, chunk) => total + chunk.length, 0);
	}

	get body(): Uint8Array {
		return new Uint8Array(Buffer.concat(this.chunks));
	}

	credit(bytes: number): void {
		this.#granted += bytes;
		this.#send({ kind: "credit", id: this.#id, bytes });
	}

	receive(frame: TunnelFrame, automatic: boolean): void {
		if (frame.kind === "response") this.status = frame.status;
		else if (frame.kind === "data") {
			this.chunks.push(new Uint8Array(frame.bytes));
			if (this.bytes > this.#granted) this.overran = true;
			if (automatic) this.credit(frame.bytes.length);
		} else if (frame.kind === "fail") {
			this.status = frame.status;
			this.failure = frame.message;
			this.#settle();
		} else if (frame.kind === "end") this.#settle();
	}
}

export class FakeRelay {
	readonly hellos: RelayHello[] = [];
	readonly announced: Extract<TunnelFrame, { kind: "shares" }>[] = [];
	readonly deletes: string[] = [];
	readonly tunnelId = "tunnel0123456789abcdef";
	readonly token = "tunneltoken0123456789abc";
	rejectWith: "unknown_tunnel" | "bad_token" | undefined;
	#socket: ServerWebSocket<undefined> | undefined;
	#server!: Server<undefined>;
	#next = 1;
	readonly #requests = new Map<number, { request: RelayRequest; automatic: boolean }>();

	static start(): FakeRelay {
		const relay = new FakeRelay();
		relay.#server = Bun.serve<undefined>({
			port: 0,
			hostname: "127.0.0.1",
			fetch: (request, server) => {
				const url = new URL(request.url);
				if (url.pathname === "/tunnel") return server.upgrade(request) ? undefined : new Response("upgrade required", { status: 426 });
				if (url.pathname === "/.well-known/dimension-artifacts") {
					return Response.json({ asp: 1, name: "Fake relay", mode: "relay", auth: {}, policy: { publicLinks: true, signinRequired: false, maxBytes: 2 ** 40, maxDays: 30 } });
				}
				if (request.method === "DELETE" && url.pathname.startsWith(`/p/${relay.tunnelId}/api/v1/shares/`)) {
					relay.deletes.push(`${url.pathname}|${request.headers.get("authorization")}`);
					return Response.json({ revoked: true });
				}
				return new Response("not found", { status: 404 });
			},
			websocket: {
				open: ws => {
					relay.#socket = ws;
				},
				message: (ws, data) => relay.#onMessage(ws, decodeFrame(new Uint8Array(data as Buffer))),
				close: ws => {
					if (relay.#socket === ws) relay.#socket = undefined;
				},
			},
		});
		return relay;
	}

	get baseUrl(): string {
		return `http://127.0.0.1:${this.#server.port}`;
	}

	get connected(): boolean {
		return this.#socket !== undefined;
	}

	stop(): void {
		void this.#server.stop(true);
	}

	drop(): void {
		this.#socket?.close(1012, "restarting");
	}

	#send = (frame: TunnelFrame): void => {
		this.#socket?.send(encodeFrame(frame) as Uint8Array<ArrayBuffer>);
	};

	#onMessage(ws: ServerWebSocket<undefined>, frame: TunnelFrame): void {
		if (frame.kind === "hello") {
			this.hellos.push({ ...(frame.tunnelId === undefined ? {} : { tunnelId: frame.tunnelId }), ...(frame.token === undefined ? {} : { token: frame.token }) });
			if (this.rejectWith !== undefined) {
				ws.send(encodeFrame({ kind: "rejected", reason: this.rejectWith, message: "no" }) as Uint8Array<ArrayBuffer>);
				ws.close(1008, "rejected");
				return;
			}
			const known = frame.tunnelId === this.tunnelId && frame.token === this.token;
			this.#send({
				kind: "welcome",
				tunnelId: this.tunnelId,
				...(known ? {} : { token: this.token }),
				baseUrl: `${this.baseUrl}/p/${this.tunnelId}`,
				window: 4096,
				maxConcurrent: 8,
				bytesPerSecond: 0,
			});
		} else if (frame.kind === "shares") this.announced.push(frame);
		else if (frame.kind === "ping") this.#send({ kind: "pong" });
		else if ("id" in frame) this.#requests.get(frame.id)?.request.receive(frame, this.#requests.get(frame.id)?.automatic ?? false);
	}

	request(path: string, options: { readonly window?: number; readonly automaticCredit?: boolean; readonly headers?: Record<string, string> } = {}): RelayRequest {
		const id = this.#next++;
		const request = new RelayRequest(id, options.window ?? 4096, this.#send);
		this.#requests.set(id, { request, automatic: options.automaticCredit ?? true });
		this.#send({ kind: "request", id, method: "GET", path, headers: options.headers ?? {}, window: options.window ?? 4096 });
		return request;
	}
}

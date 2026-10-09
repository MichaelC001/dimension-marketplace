import type { Server, ServerWebSocket } from "bun";
import type { SocketFactory, SocketLike } from "../src/dialogue.js";
import { withTimeout } from "./support.js";

export type Route = "scribe" | "dialogue";
export type SocketScript = (socket: ServerWebSocket<Route>, message: string | null) => void;
export type Handler = (request: Request) => Response | Promise<Response>;

export interface SeenRequest {
	readonly method: string;
	readonly path: string;
	readonly key: string | null;
	readonly body: string;
}

const REAL_HTTP = "https://api.elevenlabs.io";
const REAL_WS = "wss://api.elevenlabs.io";

export class FakeElevenLabs {
	readonly requests: SeenRequest[] = [];
	readonly received: string[] = [];
	readonly closed: Route[] = [];
	scribe: SocketScript = () => undefined;
	dialogue: SocketScript = () => undefined;
	scribeRefusal: Handler | undefined;
	dialogueRefusal: Handler | undefined;
	tts: Handler = () => new Response("", { status: 404 });
	user: Handler = () => new Response("{}", { status: 200 });

	readonly fetch: typeof fetch;
	readonly connect: SocketFactory;
	readonly #server: Server<Route>;
	readonly #waiters: (() => void)[] = [];

	constructor() {
		this.#server = Bun.serve<Route>({
			port: 0,
			hostname: "127.0.0.1",
			fetch: async (request, server) => {
				const path = new URL(request.url).pathname;
				this.requests.push({
					method: request.method,
					path,
					key: request.headers.get("xi-api-key"),
					body: request.method === "POST" ? await request.clone().text() : "",
				});
				this.#notify();
				if (path === "/v1/speech-to-text/realtime")
					return this.#upgrade(request, server, "scribe", this.scribeRefusal);
				if (path === "/v1/text-to-dialogue/stream-input")
					return this.#upgrade(request, server, "dialogue", this.dialogueRefusal);
				if (path === "/v1/user") return this.user(request);
				if (path.startsWith("/v1/text-to-speech/")) return this.tts(request);
				return new Response("not found", { status: 404 });
			},
			websocket: {
				open: socket => {
					this.#script(socket.data)(socket, null);
					this.#notify();
				},
				message: (socket, message) => {
					this.received.push(String(message));
					this.#script(socket.data)(socket, String(message));
					this.#notify();
				},
				close: socket => {
					this.closed.push(socket.data);
					this.#notify();
				},
			},
		});
		const wire = redirectTo(this.port);
		this.fetch = wire.fetch;
		this.connect = wire.connect;
	}

	get port(): number {
		return this.#server.port ?? 0;
	}

	get keys(): (string | null)[] {
		return this.requests.map(request => request.key);
	}

	stop(): void {
		this.#server.stop(true);
	}

	async until(done: () => boolean, what: string): Promise<void> {
		while (!done()) {
			const changed = Promise.withResolvers<void>();
			this.#waiters.push(changed.resolve);
			await withTimeout(changed.promise, what, 3_000);
		}
	}

	#notify(): void {
		for (const waiter of this.#waiters.splice(0)) waiter();
	}

	#script(route: Route): SocketScript {
		return route === "scribe" ? this.scribe : this.dialogue;
	}

	#upgrade(
		request: Request,
		server: Server<Route>,
		route: Route,
		refusal: Handler | undefined,
	): Response | Promise<Response> | undefined {
		if (refusal) return refusal(request);
		return server.upgrade(request, { data: route }) ? undefined : new Response("upgrade failed", { status: 500 });
	}
}

export function send(socket: ServerWebSocket<Route>, frame: object): void {
	socket.send(JSON.stringify(frame));
}

export async function deadPort(): Promise<number> {
	const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("") });
	const port = server.port ?? 0;
	await server.stop(true);
	return port;
}

export function redirectTo(port: number): { fetch: typeof fetch; connect: SocketFactory } {
	return {
		fetch: ((input: string | URL | Request, init?: RequestInit) =>
			fetch(String(input).replace(REAL_HTTP, `http://127.0.0.1:${port}`), init)) as unknown as typeof fetch,
		connect: (url, headers) =>
			new WebSocket(url.replace(REAL_WS, `ws://127.0.0.1:${port}`), {
				headers: { ...headers },
			} as unknown as string[]) as unknown as SocketLike,
	};
}

import {
	type AnnouncedShare,
	decodeFrame,
	encodeFrame,
	FORWARDED_RESPONSE_HEADERS,
	TUNNEL_MAX_ANNOUNCED_SHARES,
	TUNNEL_PING_INTERVAL_MS,
	TUNNEL_PROTOCOL_VERSION,
	type TunnelFrame,
	tunnelUrl,
} from "@dimension/artifact-host/tunnel-protocol";
import type { P2pRequest } from "./p2p-server";
import type { TunnelCredentials } from "./p2p-store";
import { backoffDelay, sleepFor } from "./retry";

export interface TunnelSession {
	readonly tunnelId: string;
	readonly token: string;
	readonly baseUrl: string;
}

export type TunnelRefusal = "bad_token" | "unknown_tunnel";

export interface TunnelClientOptions {
	readonly relayBase: string;
	readonly credentials: () => TunnelCredentials | undefined;
	readonly onRegistered: (session: TunnelSession) => Promise<void>;
	readonly onRefused: (reason: TunnelRefusal) => Promise<void>;
	readonly shares: () => readonly AnnouncedShare[];
	readonly handle: (request: P2pRequest) => Promise<Response>;
	readonly createSocket?: (url: string) => WebSocket;
	readonly reconnect?: { readonly baseMs: number; readonly maxMs: number; readonly rateLimitedMs: number };
	readonly log?: (message: string) => void;
}

interface RequestState {
	allowance: number;
	cancelled: boolean;
	wake?: () => void;
}

interface SessionOutcome {
	readonly refusal?: TunnelRefusal;
	readonly rateLimited?: boolean;
	readonly registered: boolean;
}

interface Waiter {
	readonly resolve: (session: TunnelSession) => void;
	readonly reject: (error: Error) => void;
}

const CLIENT_NAME = "swiss-knife-viewer/1";
const WELCOME_DEADLINE_MS = 10_000;
const MAX_DATA_FRAME_BYTES = 128 * 1024;
const SOCKET_HIGH_WATER_BYTES = 4 * 1024 * 1024;
const DEFAULT_RECONNECT = { baseMs: 1000, maxMs: 60_000, rateLimitedMs: 60_000 };
const SOCKET_OPEN = 1;

function transmit(socket: WebSocket, frame: TunnelFrame): void {
	socket.send(encodeFrame(frame) as Uint8Array<ArrayBuffer>);
}

export class TunnelClient {
	readonly #options: TunnelClientOptions;
	readonly #requests = new Map<number, RequestState>();
	readonly #waiters: Waiter[] = [];
	#session: TunnelSession | undefined;
	#socket: WebSocket | undefined;
	#running: Promise<void> | undefined;
	#abort: AbortController | undefined;
	#refusal: string | undefined;

	constructor(options: TunnelClientOptions) {
		this.#options = options;
	}

	start(): void {
		if (this.#running !== undefined) return;
		this.#refusal = undefined;
		const abort = new AbortController();
		this.#abort = abort;
		this.#running = this.#loop(abort.signal).finally(() => {
			if (this.#abort === abort) {
				this.#running = undefined;
				this.#abort = undefined;
			}
		});
	}

	async stop(): Promise<void> {
		const running = this.#running;
		this.#abort?.abort();
		this.#socket?.close(1000, "stopping");
		await running;
		this.#session = undefined;
		this.#settle(new Error("the connection to the relay was stopped"));
	}

	whenReady(signal: AbortSignal): Promise<TunnelSession> {
		if (this.#refusal !== undefined) return Promise.reject(new Error(this.#refusal));
		if (this.#session !== undefined && this.#socket?.readyState === SOCKET_OPEN) return Promise.resolve(this.#session);
		return new Promise<TunnelSession>((resolve, reject) => {
			const waiter: Waiter = { resolve, reject };
			this.#waiters.push(waiter);
			signal.addEventListener(
				"abort",
				() => {
					const at = this.#waiters.indexOf(waiter);
					if (at >= 0) this.#waiters.splice(at, 1);
					reject(new Error("the relay did not answer in time"));
				},
				{ once: true },
			);
		});
	}

	announce(): void {
		const socket = this.#socket;
		if (this.#session === undefined || socket === undefined || socket.readyState !== SOCKET_OPEN) return;
		transmit(socket, { kind: "shares", shares: this.#options.shares().slice(0, TUNNEL_MAX_ANNOUNCED_SHARES) });
	}

	#settle(error: Error | TunnelSession): void {
		for (const waiter of this.#waiters.splice(0)) {
			if (error instanceof Error) waiter.reject(error);
			else waiter.resolve(error);
		}
	}

	async #loop(signal: AbortSignal): Promise<void> {
		const reconnect = this.#options.reconnect ?? DEFAULT_RECONNECT;
		let attempt = 0;
		while (!signal.aborted) {
			const outcome = await this.#connect(signal);
			this.#socket = undefined;
			for (const state of this.#requests.values()) {
				state.cancelled = true;
				state.wake?.();
			}
			this.#requests.clear();
			if (signal.aborted) return;
			if (outcome.refusal !== undefined) {
				this.#refusal =
					outcome.refusal === "bad_token"
						? "the relay refused this computer's credential"
						: "the relay no longer knows this computer, so earlier links from it are gone";
				this.#session = undefined;
				this.#settle(new Error(this.#refusal));
				await this.#options.onRefused(outcome.refusal);
				return;
			}
			attempt = outcome.registered ? 0 : attempt + 1;
			const pause = outcome.rateLimited ? reconnect.rateLimitedMs : Math.max(reconnect.baseMs, backoffDelay(attempt, reconnect));
			try {
				await sleepFor(pause, signal);
			} catch {
				return;
			}
		}
	}

	#connect(signal: AbortSignal): Promise<SessionOutcome> {
		return new Promise<SessionOutcome>(resolve => {
			const socket = (this.#options.createSocket ?? (url => new WebSocket(url)))(tunnelUrl(this.#options.relayBase));
			socket.binaryType = "arraybuffer";
			this.#socket = socket;
			let registered = false;
			let refusal: TunnelRefusal | undefined;
			let rateLimited = false;
			let lastHeard = Date.now();
			const welcomeTimer = setTimeout(() => socket.close(4001, "no welcome"), WELCOME_DEADLINE_MS);
			const pingTimer = setInterval(() => {
				if (Date.now() - lastHeard > TUNNEL_PING_INTERVAL_MS * 2.5) {
					socket.close(4002, "silent");
					return;
				}
				if (socket.readyState === SOCKET_OPEN) transmit(socket, { kind: "ping" });
			}, TUNNEL_PING_INTERVAL_MS);
			const onAbort = (): void => socket.close(1000, "stopping");
			signal.addEventListener("abort", onAbort, { once: true });

			socket.onopen = () => {
				const credentials = this.#options.credentials();
				transmit(socket, {
					kind: "hello",
					protocol: TUNNEL_PROTOCOL_VERSION,
					client: CLIENT_NAME,
					...(credentials === undefined ? {} : { tunnelId: credentials.tunnelId, token: credentials.token }),
				});
			};
			socket.onmessage = event => {
				lastHeard = Date.now();
				let frame: TunnelFrame;
				try {
					frame = decodeFrame(new Uint8Array(event.data as ArrayBuffer));
				} catch (error) {
					this.#options.log?.(`relay sent a frame that was not understood: ${error instanceof Error ? error.message : String(error)}`);
					socket.close(1002, "protocol");
					return;
				}
				switch (frame.kind) {
					case "welcome": {
						clearTimeout(welcomeTimer);
						const token = frame.token ?? this.#options.credentials()?.token;
						if (token === undefined) {
							socket.close(1002, "no credential");
							return;
						}
						const session: TunnelSession = { tunnelId: frame.tunnelId, token, baseUrl: frame.baseUrl };
						void this.#options.onRegistered(session).then(
							() => {
								if (socket.readyState !== SOCKET_OPEN) return;
								registered = true;
								this.#session = session;
								this.announce();
								this.#settle(session);
							},
							(error: unknown) => {
								this.#options.log?.(`could not save the relay credential: ${error instanceof Error ? error.message : String(error)}`);
								socket.close(1011, "persist");
							},
						);
						return;
					}
					case "rejected":
						if (frame.reason === "bad_token" || frame.reason === "unknown_tunnel") refusal = frame.reason;
						else if (frame.reason === "rate_limited") rateLimited = true;
						else this.#options.log?.(`relay rejected this client: ${frame.message}`);
						return;
					case "request":
						void this.#serve(socket, frame);
						return;
					case "credit": {
						const state = this.#requests.get(frame.id);
						if (state !== undefined) {
							state.allowance += frame.bytes;
							state.wake?.();
						}
						return;
					}
					case "cancel": {
						const state = this.#requests.get(frame.id);
						if (state !== undefined) {
							state.cancelled = true;
							state.wake?.();
						}
						return;
					}
					default:
						return;
				}
			};
			socket.onerror = () => undefined;
			socket.onclose = () => {
				clearTimeout(welcomeTimer);
				clearInterval(pingTimer);
				signal.removeEventListener("abort", onAbort);
				resolve({ registered, rateLimited, ...(refusal === undefined ? {} : { refusal }) });
			};
		});
	}

	async #serve(socket: WebSocket, frame: Extract<TunnelFrame, { kind: "request" }>): Promise<void> {
		const state: RequestState = { allowance: frame.window, cancelled: false };
		this.#requests.set(frame.id, state);
		const send = (reply: TunnelFrame): void => {
			if (socket.readyState === SOCKET_OPEN) transmit(socket, reply);
		};
		try {
			const response = await this.#options.handle({ method: frame.method, path: frame.path, headers: new Headers(frame.headers) });
			if (state.cancelled) {
				await response.body?.cancel();
				return;
			}
			const headers: Record<string, string> = {};
			for (const [name, value] of response.headers) {
				if (FORWARDED_RESPONSE_HEADERS[name.toLowerCase()] === true) headers[name.toLowerCase()] = value;
			}
			send({ kind: "response", id: frame.id, status: response.status, headers });
			if (frame.method === "HEAD" || response.body === null) {
				send({ kind: "end", id: frame.id });
				return;
			}
			const reader = response.body.getReader();
			try {
				for (;;) {
					const { done, value } = await reader.read();
					if (done) break;
					if (!(await this.#sendData(socket, frame.id, state, value))) {
						await reader.cancel();
						return;
					}
				}
			} finally {
				reader.releaseLock();
			}
			send({ kind: "end", id: frame.id });
		} catch (error) {
			this.#options.log?.(`a relayed request failed: ${error instanceof Error ? error.message : String(error)}`);
			if (!state.cancelled) send({ kind: "fail", id: frame.id, status: 500, message: "The sharing computer could not answer that request." });
		} finally {
			this.#requests.delete(frame.id);
		}
	}

	async #sendData(socket: WebSocket, id: number, state: RequestState, bytes: Uint8Array): Promise<boolean> {
		let offset = 0;
		while (offset < bytes.length) {
			while (state.allowance <= 0 && !state.cancelled) await new Promise<void>(resolve => (state.wake = resolve));
			while (socket.bufferedAmount > SOCKET_HIGH_WATER_BYTES && socket.readyState === SOCKET_OPEN && !state.cancelled) await sleepFor(5);
			if (state.cancelled || socket.readyState !== SOCKET_OPEN) return false;
			const length = Math.min(bytes.length - offset, state.allowance, MAX_DATA_FRAME_BYTES);
			transmit(socket, { kind: "data", id, bytes: bytes.subarray(offset, offset + length) });
			state.allowance -= length;
			offset += length;
		}
		return true;
	}
}

// One scrcpy-server session on one device: the H.264 encoder a Live viewer
// watches, and the control socket a viewer's pointer drives.
//
// Lifecycle, all of it ours: push the server jar, forward a local port to its
// abstract socket, start it under `app_process`, connect the video and control
// sockets, read packets. `close()` (or any failure) kills the server, drops both
// sockets and removes the port forward. There is no polling: everything is socket
// and process events.

import type { ChildProcess } from "node:child_process";
import { randomInt } from "node:crypto";
import net from "node:net";
import type { VideoStream, VideoStreamHandlers, VideoStreamOptions } from "../backend";
import { fail } from "../contracts";
import { type Size, toPixels } from "../shared/pointer";
import type { Adb } from "./adb";
import {
  ACTION_DOWN,
  ACTION_MOVE,
  ACTION_UP,
  KEYCODES,
  keycodeMessage,
  resetVideoMessage,
  type TouchAction,
  textMessage,
  touchMessage,
  VideoStreamParser,
  type WireHandlers,
} from "./scrcpy-wire";

export interface ScrcpyDeps {
  readonly adb: Adb;
  /** The scrcpy-server file on THIS machine. */
  readonly serverPath: string;
  readonly log: (message: string) => void;
}

const REMOTE_JAR = "/data/local/tmp/inso-sim-scrcpy.jar";
const CONNECT_BUDGET_MS = 10_000;
const ATTEMPT_MS = 1_500;
const RETRY_MS = 120;
const TAIL_BYTES = 1_500;

const versions = new Map<string, string>();

function delay(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}

/**
 * The version string the server insists on. A scrcpy-server refuses to run unless
 * the client names its exact version, and says what it is when told a wrong one,
 * so the jar is asked once (and cached by path) instead of the version being
 * guessed from a directory name.
 */
async function serverVersion(deps: ScrcpyDeps, serial: string): Promise<string> {
  const override = process.env.SCRCPY_SERVER_VERSION;
  if (override) return override;
  const cached = versions.get(deps.serverPath);
  if (cached) return cached;
  const child = deps.adb.spawnShell(serial, `CLASSPATH=${REMOTE_JAR} app_process / com.genymobile.scrcpy.Server 0.0 log_level=error`);
  const output = await collect(child, 8_000);
  const found = /server version \(([^)]+)\)/.exec(output);
  if (found?.[1] === undefined) fail("scrcpy_version", `could not read scrcpy-server's version (${output.trim().slice(0, 200) || "no output"}). Is ${deps.serverPath} a scrcpy-server file?`);
  versions.set(deps.serverPath, found[1]);
  return found[1];
}

function collect(child: ChildProcess, timeoutMs: number): Promise<string> {
  const { promise, resolve } = Promise.withResolvers<string>();
  let output = "";
  const timer = setTimeout(() => child.kill(), timeoutMs);
  child.stdout?.on("data", chunk => {
    output += chunk.toString();
  });
  child.stderr?.on("data", chunk => {
    output += chunk.toString();
  });
  child.on("close", () => {
    clearTimeout(timer);
    resolve(output);
  });
  return promise;
}

interface Sockets {
  readonly video: net.Socket;
  readonly control: net.Socket;
}

export async function openVideoSession(deps: ScrcpyDeps, serial: string, options: VideoStreamOptions, handlers: VideoStreamHandlers): Promise<VideoStream> {
  await deps.adb.push(serial, deps.serverPath, REMOTE_JAR);
  const version = await serverVersion(deps, serial);
  const scid = randomInt(0, 0x7fffffff).toString(16).padStart(8, "0");
  const port = await deps.adb.forward(serial, `localabstract:scrcpy_${scid}`);
  const args = [
    `scid=${scid}`,
    "log_level=info",
    "audio=false",
    "control=true",
    "tunnel_forward=true",
    "send_dummy_byte=true",
    "send_device_meta=false",
    "send_frame_meta=true",
    "send_stream_meta=true",
    "video_codec=h264",
    `max_size=${options.maxSize}`,
    `max_fps=${options.maxFps}`,
    `video_bit_rate=${options.bitRate}`,
    "cleanup=false",
  ];
  const child = deps.adb.spawnShell(serial, `CLASSPATH=${REMOTE_JAR} app_process / com.genymobile.scrcpy.Server ${version} ${args.join(" ")}`);

  let tail = "";
  const remember = (chunk: Buffer): void => {
    tail = (tail + chunk.toString()).slice(-TAIL_BYTES);
  };
  child.stdout?.on("data", remember);
  child.stderr?.on("data", remember);

  let sockets: Sockets | null = null;
  let size: Size | null = null;
  let finished = false;
  let deliberate = false;

  const finish = (reason: string): void => {
    if (finished) return;
    finished = true;
    sockets?.video.destroy();
    sockets?.control.destroy();
    child.kill();
    void deps.adb.forwardRemove(serial, port);
    handlers.closed(reason, deliberate);
  };

  child.on("exit", code => finish(`scrcpy-server exited (${code ?? "signal"}): ${tail.trim().split("\n").pop() ?? ""}`));

  const wire: WireHandlers = {
    session: (width, height) => {
      size = { width, height };
      handlers.session(size);
    },
    packet: packet => handlers.packet(packet),
    violation: message => finish(message),
  };

  try {
    sockets = await connect(port, wire, () => finished, () => tail);
  } catch (error) {
    finish(error instanceof Error ? error.message : String(error));
    throw error;
  }
  const { video, control } = sockets;
  video.on("close", () => finish("video socket closed"));
  video.on("error", error => finish(`video socket error: ${error.message}`));
  control.on("close", () => finish("control socket closed"));
  control.on("error", error => finish(`control socket error: ${error.message}`));
  // The device may write back (clipboard); an unread socket would eventually stall the server.
  control.on("data", () => undefined);
  control.setNoDelay(true);

  const send = (message: Buffer): boolean => {
    if (finished || !control.writable) return false;
    control.write(message);
    return true;
  };

  return {
    serial,
    size: () => size,
    requestKeyframe: () => void send(resetVideoMessage()),
    touch: (action, nx, ny) => {
      if (size === null) return false;
      const at = toPixels(nx, ny, size);
      const wire: TouchAction = action === "down" ? ACTION_DOWN : action === "up" ? ACTION_UP : ACTION_MOVE;
      return send(touchMessage(wire, at.x, at.y, size.width, size.height));
    },
    key: key => {
      const code = KEYCODES[key];
      if (code === undefined) return false;
      return send(keycodeMessage(ACTION_DOWN, code)) && send(keycodeMessage(ACTION_UP, code));
    },
    text: text => send(textMessage(text)),
    close: async () => {
      deliberate = true;
      finish("closed");
    },
  };
}

/**
 * Both sockets, connected through the forwarded port. A forwarded port accepts
 * the TCP connection before the device side is listening, so a connect that
 * "succeeds" proves nothing: only the server's dummy byte does, and it is sent
 * only once the server has accepted BOTH sockets. So connect both, wait for the
 * parser to see the dummy byte and codec, and retry the pair while the server is
 * still starting.
 */
async function connect(port: number, wire: WireHandlers, isFinished: () => boolean, tail: () => string): Promise<Sockets> {
  const deadline = Date.now() + CONNECT_BUDGET_MS;
  while (Date.now() < deadline && !isFinished()) {
    const attempt = await tryPair(port, wire);
    if (attempt !== null) return attempt;
    await delay(RETRY_MS);
  }
  fail("scrcpy_start", `scrcpy-server did not accept a connection within ${CONNECT_BUDGET_MS / 1000}s${tail().trim() ? `: ${tail().trim().split("\n").pop()}` : ""}`);
}

async function tryPair(port: number, wire: WireHandlers): Promise<Sockets | null> {
  // A fresh parser per attempt: a failed attempt may have consumed part of the preamble.
  const parser = new VideoStreamParser(wire);
  const video = net.connect(port, "127.0.0.1");
  const control = net.connect(port, "127.0.0.1");
  const { promise, resolve } = Promise.withResolvers<boolean>();
  const onData = (chunk: Buffer): void => {
    parser.feed(chunk);
    if (parser.ready) resolve(true);
  };
  const fall = (): void => resolve(false);
  video.on("data", onData);
  video.once("close", fall);
  video.once("error", fall);
  control.once("close", fall);
  control.once("error", fall);
  const timer = setTimeout(fall, ATTEMPT_MS);
  const ok = await promise;
  clearTimeout(timer);
  video.off("close", fall);
  video.off("error", fall);
  control.off("close", fall);
  control.off("error", fall);
  if (ok) return { video, control };
  video.destroy();
  control.destroy();
  return null;
}

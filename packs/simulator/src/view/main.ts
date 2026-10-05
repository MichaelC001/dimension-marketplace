// The Simulator View: the standard MCP App handshake, then a pane that lists
// devices, boots and stops them, and shows the selected one live.
//
// Every fact comes over the host's bridge as a tool result; the pictures come over
// the frames lane (stream.ts). Nothing here reaches into the host window.

import {
  App,
  applyDocumentTheme,
  applyHostFonts,
  applyHostStyleVariables,
  type McpUiHostContext,
} from "@modelcontextprotocol/ext-apps/app-with-deps";
import "@fraym/ui/theme.css";
import "./style.css";
import type { DeviceInfo } from "../contracts";
import type { InputMessage, StreamMode } from "../shared/frame-protocol";
import { failureText, readList, SimulatorClient } from "./client";
import { bindInput } from "./input";
import { createShell, type Shell } from "./shell";
import { LiveStream, webCodecsPresent } from "./stream";
import { deriveScreen, type ListState, type Selection } from "./view-model";

const BOOT_BUDGET_MS = 4 * 60_000;

function applyContext(context: McpUiHostContext | undefined): void {
  if (context?.theme) applyDocumentTheme(context.theme);
  if (context?.styles?.variables) applyHostStyleVariables(context.styles.variables);
  if (context?.styles?.css?.fonts) applyHostFonts(context.styles.css.fonts);
}

const root = document.getElementById("root");
if (root === null) throw new Error("simulator view: missing #root");

function fatal(message: string): void {
  const box = document.createElement("div");
  box.className = "sim-boot";
  box.setAttribute("role", "alert");
  box.append(Object.assign(document.createElement("h1"), { textContent: "Simulator view could not connect" }), Object.assign(document.createElement("p"), { textContent: message }));
  root?.replaceChildren(box);
}

async function main(): Promise<void> {
  const app = new App({ name: "simulator", version: "0.1.0" }, {}, { autoResize: false });

  let list: ListState | null = null;
  let failure: string | null = null;
  /** What the last boot or stop said went wrong; cleared by the next one. */
  let problem: string | null = null;
  let busy = false;
  let selection: Selection = { serial: null, booting: null };
  let selectedAvd: string | null = null;
  let attached: string | null = null;
  let shell: Shell | null = null;
  let stream: LiveStream | null = null;
  let client: SimulatorClient | null = null;
  let unbind: (() => void) | null = null;

  // Registered BEFORE connect(): the tool result that mounted this View may arrive with the handshake.
  app.addEventListener("toolresult", result => {
    const value = result.structuredContent;
    if (value === undefined) return;
    const fresh = readList(value);
    if (fresh === null) return;
    list = fresh;
    failure = null;
    const serial = value.serial;
    if (typeof serial === "string") selection = { ...selection, serial };
    render();
  });
  app.onhostcontextchanged = context => applyContext({ ...app.getHostContext(), ...context });

  await app.connect();
  applyContext(app.getHostContext());
  client = new SimulatorClient(app);

  function detach(): void {
    stream?.stop();
    attached = null;
    shell?.status(null);
  }

  function select(device: DeviceInfo): void {
    if (shell === null || client === null || attached === device.serial) return;
    detach();
    const owner = client;
    const next = shell;
    attached = device.serial;
    stream ??= new LiveStream(next.canvas, {
      acquire: (mode: StreamMode) => owner.stream(attached ?? device.serial, mode),
      onSize: (width, height) => next.aspect(width, height),
      onStatus: status => {
        next.status(status);
        // A device that stopped under us: look again rather than show a dead picture.
        if (status.phase === "ended") void refresh();
      },
    });
    stream.start(webCodecsPresent() ? "h264" : "shot");
  }

  function render(): void {
    if (shell === null) return;
    const screen = deriveScreen(list, selection, failure);
    shell.render(screen, list, selectedAvd, busy, problem);
    if (screen.kind === "device" && screen.device.state === "online") select(screen.device);
    else if (attached !== null) detach();
  }

  async function refresh(): Promise<void> {
    if (client === null) return;
    try {
      list = await client.list();
      failure = null;
    } catch (error) {
      failure = failureText(error);
    }
    render();
  }

  async function bootAvd(name: string): Promise<void> {
    if (client === null || busy) return;
    busy = true;
    problem = null;
    selection = { ...selection, booting: name };
    selectedAvd = null;
    render();
    const deadline = Date.now() + BOOT_BUDGET_MS;
    try {
      // The tool answers within its wait cap and says whether the device is up: ask again until it is.
      for (;;) {
        const outcome = await client.boot(name);
        if (!outcome.pending) {
          selection = { serial: outcome.device.serial, booting: null };
          break;
        }
        if (Date.now() > deadline) throw new Error(`${name} did not finish booting in ${BOOT_BUDGET_MS / 60_000} minutes. Check the emulator, then press Check again.`);
      }
    } catch (error) {
      problem = failureText(error);
      selection = { ...selection, booting: null };
    }
    busy = false;
    await refresh();
  }

  async function stop(serial: string): Promise<void> {
    if (client === null || busy) return;
    busy = true;
    problem = null;
    detach();
    render();
    try {
      await client.stop(serial);
      selection = { serial: null, booting: null };
    } catch (error) {
      problem = failureText(error);
    }
    busy = false;
    await refresh();
  }

  shell = createShell(root as HTMLElement, {
    select: choice => {
      if ("serial" in choice) {
        selection = { ...selection, serial: choice.serial };
        selectedAvd = null;
      } else {
        selectedAvd = choice.avd;
      }
      render();
    },
    boot: name => void bootAvd(name),
    stop: serial => void stop(serial),
    refresh: () => void refresh(),
    nav: key => {
      const message: InputMessage = { t: "k", key };
      stream?.send(message);
    },
  });
  unbind = bindInput(shell.canvas, message => stream?.send(message));
  window.addEventListener("pagehide", () => {
    unbind?.();
    stream?.stop();
  });
  // The person comes back to the pane: look again (a boot, a stop or a crash may have happened elsewhere).
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && attached === null) void refresh();
  });

  render();
  if (list === null) await refresh();
}

main().catch((error: unknown) => fatal(failureText(error)));

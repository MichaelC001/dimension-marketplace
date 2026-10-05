// The pane's DOM: built once, then updated in place. React is not used here on
// purpose: the part that matters (pictures at 30-60 per second) must never go
// through a render, and the rest is a bar, a phone and a panel.

import type { DeviceInfo } from "../contracts";
import { type ListState, type MissingTool, modeLabel, type PickerOption, pickerOptions, type Screen, type StreamStatus } from "./view-model";

type Child = Node | string;

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, attrs: Record<string, string> = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className !== "") node.className = className;
  for (const [name, value] of Object.entries(attrs)) node.setAttribute(name, value);
  node.append(...children);
  return node;
}

export interface ShellHandlers {
  /** The picker moved to a running device (`serial`) or an AVD (`avd`). */
  select(choice: { serial: string } | { avd: string }): void;
  boot(avd: string): void;
  stop(serial: string): void;
  refresh(): void;
  /** The person flipped "Show physical devices". */
  showPhysical(show: boolean): void;
  nav(key: "back" | "home" | "recents"): void;
}

export interface Shell {
  readonly canvas: HTMLCanvasElement;
  render(screen: Screen, list: ListState | null, selectedAvd: string | null, busy: boolean, problem: string | null, showPhysical: boolean): void;
  status(status: StreamStatus | null): void;
  aspect(width: number, height: number): void;
}

const NAV: readonly { readonly key: "back" | "home" | "recents"; readonly label: string; readonly glyph: string }[] = [
  { key: "back", label: "Back", glyph: "M15 5l-7 7 7 7" },
  { key: "home", label: "Home", glyph: "M12 4a8 8 0 100 16 8 8 0 000-16z" },
  { key: "recents", label: "Recents", glyph: "M5 5h14v14H5z" },
];

function icon(path: string): SVGSVGElement {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", "18");
  svg.setAttribute("height", "18");
  svg.setAttribute("aria-hidden", "true");
  const shape = document.createElementNS("http://www.w3.org/2000/svg", "path");
  shape.setAttribute("d", path);
  shape.setAttribute("fill", "none");
  shape.setAttribute("stroke", "currentColor");
  shape.setAttribute("stroke-width", "2");
  shape.setAttribute("stroke-linecap", "round");
  shape.setAttribute("stroke-linejoin", "round");
  svg.append(shape);
  return svg;
}

function button(label: string, className: string, onClick: () => void): HTMLButtonElement {
  const node = el("button", `sim-btn ${className}`.trim(), { type: "button" }, label);
  node.addEventListener("click", onClick);
  return node;
}

const GROUP_LABELS: Record<PickerOption["group"], string> = { running: "Running", physical: "Physical devices (your own phone)", boot: "Not running" };

function optionGroups(select: HTMLSelectElement, options: readonly PickerOption[], current: string): void {
  select.replaceChildren();
  for (const group of ["running", "physical", "boot"] as const) {
    const items = options.filter(option => option.group === group);
    if (items.length === 0) continue;
    const container = el("optgroup", "", { label: GROUP_LABELS[group] });
    for (const option of items) {
      const node = el("option", "", { value: option.value }, option.label);
      node.selected = option.value === current;
      container.append(node);
    }
    select.append(container);
  }
}

export function createShell(root: HTMLElement, handlers: ShellHandlers): Shell {
  const picker = el("select", "sim-picker", { "aria-label": "Device" });
  const bootButton = button("Boot", "sim-btn-primary", () => bootTarget && handlers.boot(bootTarget));
  const stopButton = button("Stop", "", () => stopTarget && handlers.stop(stopTarget));
  const refreshButton = button("Refresh", "sim-btn-quiet", () => handlers.refresh());
  const physicalToggle = el("input", "", { type: "checkbox", "aria-describedby": "sim-physical-note" });
  physicalToggle.addEventListener("change", () => handlers.showPhysical(physicalToggle.checked));
  const physicalNote = el("span", "sim-toggle-note", { id: "sim-physical-note" });
  const physicalLabel = el("label", "sim-toggle", {}, physicalToggle, el("span", "", {}, "Show physical devices"));
  const physicalBadge = el("span", "sim-chip", { "data-chip": "physical", title: "A real phone: somebody's own device, not an emulator." }, "Physical device");
  const modeChip = el("span", "sim-chip", { "data-chip": "mode" });
  const fpsChip = el("span", "sim-chip sim-num", { "data-chip": "fps" });
  const latencyChip = el("span", "sim-chip sim-num", { "data-chip": "latency" });
  const chips = el("div", "sim-chips", { "aria-live": "polite" }, modeChip, fpsChip, latencyChip);
  const bar = el("header", "sim-bar", {}, picker, physicalBadge, bootButton, stopButton, refreshButton, physicalLabel, physicalNote, el("span", "sim-spacer"), chips);

  const canvas = el("canvas", "sim-canvas", { tabindex: "0", role: "application", "aria-label": "Device screen. Click and drag to touch, type to enter text." });
  const veil = el("div", "sim-veil", { role: "status" });
  const bezel = el("div", "sim-bezel", {}, canvas, veil);
  const screenbox = el("div", "sim-screenbox", {}, bezel);
  const navRow = el("nav", "sim-nav", { "aria-label": "Device buttons" });
  for (const item of NAV) {
    const node = el("button", "sim-nav-btn", { type: "button", "aria-label": item.label, title: item.label }, icon(item.glyph));
    node.addEventListener("click", () => handlers.nav(item.key));
    navRow.append(node);
  }
  const note = el("p", "sim-note", { role: "note" });
  const phone = el("section", "sim-phone", {}, note, screenbox, navRow);
  const panel = el("section", "sim-panel", { role: "region" });
  const stage = el("main", "sim-stage", {}, phone, panel);
  const problemBanner = el("p", "sim-problem", { role: "alert" });
  root.replaceChildren(el("div", "sim-root", {}, bar, problemBanner, stage));

  let bootTarget: string | null = null;
  let stopTarget: string | null = null;

  picker.addEventListener("change", () => {
    const value = picker.value;
    if (value.startsWith("serial:")) handlers.select({ serial: value.slice("serial:".length) });
    else if (value.startsWith("avd:")) handlers.select({ avd: value.slice("avd:".length) });
  });

  function showPanel(title: string, body: Child[], actions: HTMLElement[] = [], tone: "plain" | "problem" = "plain"): void {
    panel.dataset.tone = tone;
    panel.replaceChildren(el("h1", "sim-panel-title", {}, title), ...body, ...(actions.length > 0 ? [el("div", "sim-actions", {}, ...actions)] : []));
  }

  function missingList(missing: readonly MissingTool[]): HTMLElement {
    const list = el("ul", "sim-missing");
    for (const item of missing) list.append(el("li", "", {}, el("code", "sim-code", {}, item.tool), el("span", "sim-missing-need", {}, ` — needed for ${item.needed}`), el("p", "sim-missing-fix", {}, item.fix)));
    return list;
  }

  return {
    canvas,
    aspect: (width, height) => {
      bezel.style.setProperty("--aw", String(width));
      bezel.style.setProperty("--ah", String(height));
    },
    status: status => {
      if (status === null) {
        modeChip.textContent = "";
        fpsChip.textContent = "";
        latencyChip.textContent = "";
        chips.hidden = true;
        veil.hidden = true;
        return;
      }
      chips.hidden = false;
      modeChip.textContent = modeLabel(status);
      modeChip.dataset.kind = status.phase !== "live" ? status.phase : status.mode;
      modeChip.title = status.fallbackReason ?? status.detail ?? "";
      const live = status.phase === "live";
      fpsChip.hidden = !live;
      latencyChip.hidden = !live || status.latencyMs === null;
      fpsChip.textContent = `${status.fps} fps`;
      latencyChip.textContent = status.latencyMs === null ? "" : `${status.latencyMs} ms`;
      const covered = status.phase === "connecting" || status.phase === "reconnecting" || status.phase === "ended";
      veil.hidden = !covered;
      veil.textContent = status.phase === "ended" ? `Stopped${status.detail ? `: ${status.detail}` : ""}` : status.phase === "reconnecting" ? `Reconnecting${status.detail ? ` (${status.detail})` : ""}…` : "Connecting…";
    },
    render: (screen, list, selectedAvd, busy, problem, showPhysical) => {
      problemBanner.hidden = problem === null;
      problemBanner.textContent = problem ?? "";
      const device: DeviceInfo | null = screen.kind === "device" ? screen.device : null;
      const allowed = list?.allowPhysical === true;
      physicalToggle.disabled = list === null || !allowed || busy;
      physicalToggle.checked = allowed && showPhysical;
      physicalLabel.title = allowed ? "List phones attached over USB or Wi-Fi next to the emulators. A phone is your own device." : "Driving a physical phone is turned off in settings.";
      physicalNote.hidden = list === null || allowed;
      physicalNote.textContent = "Off in settings (Simulator → Allow driving a physical phone).";
      physicalBadge.hidden = device?.kind !== "physical";
      stopTarget = device?.owned === true ? device.serial : null;
      bootTarget = selectedAvd;
      stopButton.hidden = stopTarget === null;
      stopButton.disabled = busy;
      bootButton.hidden = bootTarget === null;
      bootButton.disabled = busy;
      refreshButton.disabled = busy;
      picker.disabled = list === null || busy;
      if (list !== null) optionGroups(picker, pickerOptions(list, showPhysical), selectedAvd !== null ? `avd:${selectedAvd}` : device !== null ? `serial:${device.serial}` : "");
      phone.hidden = screen.kind !== "device";
      panel.hidden = screen.kind === "device";
      if (screen.kind === "device") {
        const live = screen.notes.find(item => item.tool === "scrcpy-server");
        note.hidden = live === undefined;
        note.textContent = live === undefined ? "" : `Live video needs scrcpy-server, so this is Shot fallback (still pictures). ${live.fix}`;
        return;
      }
      switch (screen.kind) {
        case "loading":
          showPanel("Looking for devices…", [el("p", "sim-lede", {}, "Asking the simulator for what is running.")]);
          break;
        case "unavailable":
          showPanel("The simulator is not available", [el("p", "sim-lede", {}, screen.reason)], [button("Try again", "", () => handlers.refresh())], "problem");
          break;
        case "missing-adb":
          showPanel("Android tools not found", [el("p", "sim-lede", {}, "The simulator drives devices with adb, which this machine does not have (or the pack cannot find)."), missingList(screen.missing)], [button("Check again", "sim-btn-primary", () => handlers.refresh())], "problem");
          break;
        case "no-device": {
          const avds = screen.avds;
          const actions = avds.map((name, index) => button(`Boot ${name}`, index === 0 ? "sim-btn-primary" : "", () => handlers.boot(name)));
          const body: Child[] = [
            el("p", "sim-lede", {}, avds.length > 0 ? "No device is running. Boot one to watch and drive it here, beside your conversation." : "No device is running, and there is no Android virtual device to boot."),
          ];
          if (screen.missing.length > 0) body.push(missingList(screen.missing));
          else if (avds.length === 0) body.push(el("p", "sim-missing-fix", {}, "Create one in Android Studio → Device Manager (or with avdmanager), then check again."));
          if (screen.hiddenPhones > 0) body.push(el("p", "sim-missing-fix", {}, `${screen.hiddenPhones === 1 ? "A physical phone is attached and is" : `${screen.hiddenPhones} physical phones are attached and are`} not shown: the pane lists emulators only, unless Show physical devices is on and allowed in settings.`));
          if (screen.listedPhones > 0) body.push(el("p", "sim-missing-fix", {}, "Pick your physical phone from the device list to open it here. The pane never opens one for you."));
          showPanel("No device running", body, [...actions, button("Check again", "sim-btn-quiet", () => handlers.refresh())]);
          break;
        }
        case "booting":
          showPanel(`Booting ${screen.avd}…`, [el("div", "sim-spinner", { role: "progressbar", "aria-label": "Booting" }), el("p", "sim-lede", {}, "A cold boot takes up to a minute. This pane opens the device the moment it is ready.")]);
          break;
      }
    },
  };
}

// The pane's chrome: ONE toolbar across the top, and the markup of a frozen frame.
//
// The bar is the shared annotation kit's `AnnotationToolbar` (the same bar the Viewer and the Browser wear): the
// device controls are its first group, the drawing tools its next, and the stream's status its trailing slot.
// With no tool in hand the pane drives the device exactly as before. Picking a tool up freezes the frame on the
// canvas into a picture (the synchronous encoder: a deliberate click pays what the pixels cost, never `toBlob`'s
// idle wait), lays `MarkupOverlay` over it and takes the screen and the device buttons out of input's reach, so
// a stroke never becomes a tap. Request edits stages the marked-up frame, with which device it is and where each
// mark lands in the device's own pixels; the human sends it from the chat.
//
// A React island in the vanilla pane, not a React pane: the canvas, the stream and the panels stay in shell.ts,
// and this mounts into the slots it leaves.

import "@dimension/mcp-app-kit/annotate/annotate.css";
import type { EnrichHook, MarkTool } from "@dimension/mcp-app-kit/annotate";
import {
  AnnotationFooter,
  AnnotationToolbar,
  MarkupOverlay,
  markupToolGroups,
  type ToolGroupDef,
  useImageMarkup,
  useMarkupShortcuts,
} from "@dimension/mcp-app-kit/annotate/react";
import type { App } from "@modelcontextprotocol/ext-apps/app-with-deps";
import { type IconName, iconPaths } from "@fraym/ui/icons";
import { type FocusEvent, type ReactElement, type RefObject, useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { createRoot } from "react-dom/client";
import type { DeviceInfo } from "../contracts";
import type { Size } from "../shared/pointer";
import type { Shell } from "./shell";
import {
  type DeviceDot,
  deviceControls,
  keepFrozen,
  type ListState,
  markFact,
  markupKeysLive,
  type PickerOption,
  type Screen,
  screenFact,
  type StatusLine,
  statusLine,
  type StreamStatus,
} from "./view-model";

export interface ChromeFacts {
  readonly screen: Screen;
  readonly list: ListState | null;
  readonly selectedAvd: string | null;
  readonly busy: boolean;
  readonly showPhysical: boolean;
  readonly status: StreamStatus | null;
  /** The size of the canvas once the stream has sized it for a frame; null before the first. */
  readonly frame: Size | null;
}

export interface ChromeHandlers {
  select(choice: { serial: string } | { avd: string }): void;
  boot(avd: string): void;
  stop(serial: string): void;
  refresh(): void;
  showPhysical(show: boolean): void;
  /** False while a tool is in hand: the screen is a picture being marked, not the device. */
  driving(on: boolean): void;
}

export interface Chrome {
  update(facts: Partial<ChromeFacts>): void;
}

interface Store {
  subscribe(listener: () => void): () => void;
  get(): ChromeFacts;
}

export function mountChrome(app: App, shell: Shell, initial: ChromeFacts, handlers: ChromeHandlers): Chrome {
  let facts = initial;
  const listeners = new Set<() => void>();
  const store: Store = {
    subscribe: listener => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    get: () => facts,
  };
  createRoot(shell.bar).render(<ChromeView app={app} shell={shell} store={store} handlers={handlers} />);
  return {
    update: next => {
      facts = { ...facts, ...next };
      for (const listener of listeners) listener();
    },
  };
}

// ── glyphs ────────────────────────────────────────────────────────────

function Glyph({ name }: { readonly name: IconName }): ReactElement {
  return (
    <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      {iconPaths[name].split("|").map(d => (
        <path key={d} d={d} />
      ))}
    </svg>
  );
}

/** A phone on a cable: somebody's own device, attached to this machine. */
function PhysicalGlyph({ on }: { readonly on: boolean }): ReactElement {
  return (
    <span className="sim-glyph" data-on={on || undefined}>
      <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
        <path d="M7 2h8a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1z" />
        <path d="M11 16v3a2 2 0 0 0 2 2h6" />
      </svg>
    </span>
  );
}

function Dot({ dot }: { readonly dot: DeviceDot }): ReactElement {
  return <span className="sim-dot" data-dot={dot} aria-hidden="true" />;
}

function DeviceGlyph({ dot, physical }: { readonly dot: DeviceDot | null; readonly physical: boolean }): ReactElement {
  return (
    <span className="sim-glyph sim-devglyph" data-physical={physical || undefined}>
      <Glyph name="phone" />
      {dot === null ? null : <Dot dot={dot} />}
    </span>
  );
}

const DOT_WORDS: Readonly<Record<DeviceDot, string>> = { online: "running", starting: "starting", off: "not running" };
const GROUP_LABELS: Readonly<Record<PickerOption["group"], string>> = { running: "Running", physical: "Physical devices (your own phone)", boot: "Not running" };

// ── the frozen frame ──────────────────────────────────────────────────

interface Frozen {
  readonly url: string;
  readonly size: Size;
  /** Wall-clock time it was frozen, HH:MM:SS: what the human and the agent call it. */
  readonly at: string;
  readonly device: DeviceInfo;
}

const PNG = "data:image/png;base64,";

/** The frame the canvas holds now, as a picture. Null when the canvas has nothing or the encoder refuses it. */
function freezeFrame(canvas: HTMLCanvasElement, device: DeviceInfo): Frozen | null {
  if (canvas.width === 0 || canvas.height === 0) return null;
  const url = canvas.toDataURL("image/png");
  if (!url.startsWith(PNG)) return null;
  return { url, size: { width: canvas.width, height: canvas.height }, at: new Date().toTimeString().slice(0, 8), device };
}

function bytesOf(url: string): Uint8Array {
  const text = atob(url.slice(PNG.length));
  const bytes = new Uint8Array(text.length);
  for (let index = 0; index < text.length; index += 1) bytes[index] = text.charCodeAt(index);
  return bytes;
}

function screenName(device: DeviceInfo): string {
  return `${device.name} (${device.serial}) screen`;
}

// ── the device menu ───────────────────────────────────────────────────

const ITEMS = '[role="menuitemradio"]';

/** Outside press and Escape close it; arrows, Home and End walk it; it opens on the device shown and gives focus back to its button. */
function useDeviceMenu(open: boolean, close: () => void, wrap: RefObject<HTMLDivElement | null>): void {
  const latest = useRef(close);
  latest.current = close;
  useEffect(() => {
    const opener = wrap.current?.querySelector<HTMLElement>('[data-tool="device"]');
    opener?.setAttribute("aria-haspopup", "menu");
    opener?.setAttribute("aria-expanded", String(open));
    if (!open) return;
    const items = () => [...(wrap.current?.querySelectorAll<HTMLElement>(ITEMS) ?? [])];
    const onDown = (event: PointerEvent) => {
      if (!wrap.current?.querySelector(".sim-menu")?.contains(event.target as Node) && !opener?.contains(event.target as Node)) latest.current();
    };
    const onKey = (event: KeyboardEvent) => {
      const list = items();
      const index = list.findIndex(item => item === document.activeElement);
      if (event.key === "Escape") latest.current();
      else if (event.key === "ArrowDown" || event.key === "ArrowUp") list[(index + (event.key === "ArrowDown" ? 1 : -1) + list.length) % list.length]?.focus();
      else if (event.key === "Home" || event.key === "End") list[event.key === "Home" ? 0 : list.length - 1]?.focus();
      else return;
      event.preventDefault();
      event.stopImmediatePropagation();
    };
    window.addEventListener("pointerdown", onDown);
    window.addEventListener("keydown", onKey, true);
    (wrap.current?.querySelector<HTMLElement>(`${ITEMS}[aria-checked="true"]`) ?? items()[0])?.focus();
    return () => {
      window.removeEventListener("pointerdown", onDown);
      window.removeEventListener("keydown", onKey, true);
      if (wrap.current?.contains(document.activeElement) || document.activeElement === document.body) opener?.focus();
    };
  }, [open, wrap]);
}

function DeviceMenu({ options, current, onChoose }: { readonly options: readonly PickerOption[]; readonly current: string | null; readonly onChoose: (option: PickerOption) => void }): ReactElement {
  return (
    <div className="sim-menu dam-root" role="menu" aria-label="Devices">
      {(["running", "physical", "boot"] as const).map(group => {
        const items = options.filter(option => option.group === group);
        if (items.length === 0) return null;
        return (
          <div key={group} role="group" aria-label={GROUP_LABELS[group]} className="sim-menu-group">
            <div className="sim-menu-head" aria-hidden="true">
              {GROUP_LABELS[group]}
            </div>
            {items.map(option => (
              <button
                key={option.value}
                type="button"
                role="menuitemradio"
                aria-checked={option.value === current}
                className="sim-menu-item"
                tabIndex={-1}
                onClick={() => onChoose(option)}
              >
                <Dot dot={option.dot} />
                <span className="sim-menu-name">{option.name}</span>
                <span className="sim-menu-meta">{option.serial ?? "Boot"}</span>
                {option.group === "physical" ? <span className="sim-menu-tag">physical</span> : null}
              </button>
            ))}
          </div>
        );
      })}
      {options.length === 0 ? <p className="sim-menu-empty">No device to choose. Refresh to look again.</p> : null}
    </div>
  );
}

// ── the bar, the frozen frame and the request ─────────────────────────

function Status({ line }: { readonly line: StatusLine }): ReactElement {
  return (
    <span className="sim-status" data-tone={line.tone} title={line.title}>
      <span className="sim-status-dot" aria-hidden="true" />
      <span className="sim-status-text">{line.text}</span>
      {/* Read out when the phase changes, not on every frame-rate tick. */}
      <span className="sim-sr" role="status">
        {line.text.split(" · ")[0]}
      </span>
    </span>
  );
}

function ChromeView({ app, shell, store, handlers }: { readonly app: App; readonly shell: Shell; readonly store: Store; readonly handlers: ChromeHandlers }): ReactElement {
  const facts = useSyncExternalStore(store.subscribe, store.get);
  const { screen, frame } = facts;
  const controls = deviceControls(screen, facts.list, facts.selectedAvd, facts.busy, facts.showPhysical);
  const device = screen.kind === "device" ? screen.device : null;

  const [frozen, setFrozenState] = useState<Frozen | null>(null);
  const frozenRef = useRef<Frozen | null>(null);
  const setFrozen = useCallback((next: Frozen | null) => {
    frozenRef.current = next;
    setFrozenState(next);
  }, []);
  const deviceRef = useRef(device);
  deviceRef.current = device;

  const loadBytes = useCallback(async () => {
    const shot = frozenRef.current;
    if (shot === null) throw new Error("no frame is frozen. Pick a tool to freeze one.");
    return bytesOf(shot.url);
  }, []);
  const enrich = useCallback<EnrichHook>(async ({ marks }) => {
    const shot = frozenRef.current;
    if (shot === null) return {};
    return {
      annotation: { summary: screenFact(shot.device, shot.size, shot.at) },
      marks: marks.flatMap(mark => {
        const summary = markFact(mark.shape, shot.device.display, shot.size);
        return summary === null ? [] : [{ id: mark.id, summary }];
      }),
    };
  }, []);
  // One session per device, not per frame: a frame is only ever let go with no marks on it (keepFrozen), so a new
  // freeze never inherits marks, and the overall message the human typed survives a freeze and a return to live.
  const shown = frozen?.device ?? device;
  const session = useImageMarkup({ app, file: shown === null ? "Simulator screen" : screenName(shown), loadBytes, enrich });
  const { markup, tool, setTool } = session;

  const canMark = frozen !== null || (device !== null && frame !== null && facts.status?.phase === "live");
  const pickUp = useCallback(
    (next: MarkTool | null) => {
      if (next !== null && frozenRef.current === null) {
        const shown = deviceRef.current;
        const shot = shown === null ? null : freezeFrame(shell.canvas, shown);
        if (shot === null) return;
        setFrozen(shot);
      }
      setTool(next);
    },
    [setTool, setFrozen, shell.canvas],
  );
  const putDown = useCallback(() => setTool(null), [setTool]);

  // Letting a frame go also forgets its undo history: an undo must not bring marks back with no frame under them.
  useEffect(() => {
    if (frozen === null || keepFrozen(tool, markup.marks.length)) return;
    setFrozen(null);
    markup.reset();
  }, [frozen, tool, markup, setFrozen]);
  // Marks belong to the device they were drawn on: another device, or none, takes the frame and the tool down.
  useEffect(() => {
    if (frozen !== null && device?.serial !== frozen.device.serial) {
      setTool(null);
      setFrozen(null);
    }
  }, [device?.serial, frozen, setTool, setFrozen]);

  const showing = frozen !== null && tool !== null;
  useEffect(() => handlers.driving(!showing), [showing, handlers]);

  const [menuOpen, setMenuOpen] = useState(false);
  const closeMenu = useCallback(() => setMenuOpen(false), []);
  const wrap = useRef<HTMLDivElement | null>(null);
  useDeviceMenu(menuOpen, closeMenu, wrap);
  const [barFocused, setBarFocused] = useState(false);
  const onBlur = (event: FocusEvent<HTMLDivElement>) => {
    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setBarFocused(false);
  };

  useMarkupShortcuts({ enabled: canMark && markupKeysLive(tool, barFocused, menuOpen), onTool: pickUp, onUndo: markup.undo, onRedo: markup.redo, onExit: putDown });

  const current = controls.current;
  const { boot, stop, physical } = controls;
  const named = current === null ? "none running, choose one" : `${current.name}${current.serial === null ? "" : ` (${current.serial})`}, ${DOT_WORDS[current.dot]}${current.physical ? ", your own phone" : ""}. Choose another`;
  const groups: ToolGroupDef[] = [
    {
      id: "device",
      label: "Device",
      kind: "act",
      tools: [
        { id: "device", label: `Device: ${named}`, icon: <DeviceGlyph dot={current?.dot ?? null} physical={current?.physical === true} />, text: current?.name ?? "No device", disabled: controls.pickerDisabled, onSelect: () => setMenuOpen(open => !open) },
        { id: "boot", label: boot.label, icon: <Glyph name="play" />, disabled: boot.disabled, onSelect: () => boot.avd !== null && handlers.boot(boot.avd) },
        { id: "stop", label: stop.label, icon: <Glyph name="square" />, disabled: stop.disabled, onSelect: () => stop.serial !== null && handlers.stop(stop.serial) },
        { id: "refresh", label: "Refresh devices", icon: <Glyph name="refresh" />, disabled: controls.refreshDisabled, onSelect: () => handlers.refresh() },
        { id: "physical", label: physical.label, icon: <PhysicalGlyph on={physical.on} />, disabled: physical.disabled, onSelect: () => handlers.showPhysical(!physical.on) },
      ],
    },
    ...markupToolGroups({
      tool,
      onTool: pickUp,
      canUndo: markup.canUndo,
      canRedo: markup.canRedo,
      onUndo: markup.undo,
      onRedo: markup.redo,
      onClear: markup.clear,
      hasMarks: markup.marks.length > 0,
    }).map(group => (group.id === "drawing" && !canMark ? { ...group, tools: group.tools.map(entry => ({ ...entry, disabled: true })) } : group)),
  ];

  const line: StatusLine | null = showing ? { text: `Frozen at ${frozen.at} · Esc for live`, tone: "quiet", title: "You are marking a still frame. Put the tool down (Esc, or press it again) to drive the device." } : statusLine(facts.status);
  const choose = (option: PickerOption) => {
    setMenuOpen(false);
    handlers.select(option.serial !== null ? { serial: option.serial } : { avd: option.name });
  };

  // The portals sit outside the bar's element: focus in the footer or on the frozen frame is not "the toolbar has focus".
  return (
    <>
      <div className="sim-bar" ref={wrap} onFocus={() => setBarFocused(true)} onBlur={onBlur}>
        <AnnotationToolbar label="Device and annotation tools" placement="strip" ownClass="sim-toolbar" groups={groups} trailing={line === null ? undefined : <Status line={line} />} />
        {menuOpen ? <DeviceMenu options={controls.options} current={current?.value ?? null} onChoose={choose} /> : null}
      </div>
      {showing
        ? createPortal(
            <div className="sim-frozen">
              <img className="sim-frozen-img" src={frozen.url} alt="" draggable={false} />
              <MarkupOverlay
                marks={markup.marks}
                tool={tool}
                onShape={session.onShape}
                onNote={markup.setNote}
                onRemove={markup.remove}
                label={`Draw on the frozen screen of ${frozen.device.name}`}
              />
            </div>,
            shell.freeze,
          )
        : null}
      {createPortal(
        <AnnotationFooter
          message={session.message}
          onMessage={session.setMessage}
          onSend={() => void session.send()}
          send={{ busy: session.sending, staged: session.staged }}
          status={session.status}
          count={markup.marks.length}
        />,
        shell.foot,
      )}
    </>
  );
}

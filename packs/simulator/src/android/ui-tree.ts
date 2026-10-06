// UI Automator: the dump parser, and the hit test `device_tap {label}` uses.
//
// `uiautomator dump` answers an XML tree of every view on screen with its text,
// content description, resource id, flags and pixel bounds. That is the one
// cross-app, no-instrumentation way to know where a control is, and it is what an
// agent should tap by instead of guessing coordinates from a screenshot.

import { fail, type UiNode, type UiSnapshot } from "../contracts";
import type { Size } from "../shared/pointer";

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

function decode(value: string): string {
  return value.replace(/&(?:#x([0-9a-fA-F]+)|#(\d+)|(amp|lt|gt|quot|apos));/g, (_match, hex?: string, dec?: string, name?: string) => {
    if (name !== undefined) return ENTITIES[name] ?? "";
    const code = hex !== undefined ? Number.parseInt(hex, 16) : Number(dec);
    return Number.isInteger(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : "";
  });
}

function attributes(source: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const match of source.matchAll(/([\w:-]+)="([^"]*)"/g)) {
    if (match[1] !== undefined && match[2] !== undefined) out[match[1]] = decode(match[2]);
  }
  return out;
}

/** The XML of a dump, without the trailer `uiautomator dump /dev/tty` appends. */
export function dumpXml(raw: string): string {
  const start = raw.indexOf("<?xml");
  const first = start >= 0 ? start : raw.indexOf("<hierarchy");
  const end = raw.lastIndexOf("</hierarchy>");
  if (first < 0 || end < 0) fail("ui_dump_failed", `uiautomator returned no hierarchy: ${raw.trim().slice(0, 160) || "(empty)"}. A secure screen, or an app mid-transition, can refuse a dump; retry in a second.`);
  return raw.slice(first, end + "</hierarchy>".length);
}

export function parseUiDump(raw: string): UiSnapshot {
  const xml = dumpXml(raw);
  const nodes: UiNode[] = [];
  let depth = 0;
  for (const tag of xml.matchAll(/<(\/?)node\b([^>]*?)(\/?)>/g)) {
    const closing = tag[1] === "/";
    const selfClosing = tag[3] === "/";
    if (closing) {
      depth -= 1;
      continue;
    }
    const attrs = attributes(tag[2] ?? "");
    const bounds = /^\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]$/.exec(attrs.bounds ?? "");
    if (bounds !== null) {
      nodes.push({
        index: nodes.length,
        depth,
        text: attrs.text ?? "",
        desc: attrs["content-desc"] ?? "",
        id: attrs["resource-id"] ?? "",
        cls: attrs.class ?? "",
        pkg: attrs.package ?? "",
        bounds: { left: Number(bounds[1]), top: Number(bounds[2]), right: Number(bounds[3]), bottom: Number(bounds[4]) },
        clickable: attrs.clickable === "true",
        longClickable: attrs["long-clickable"] === "true",
        enabled: attrs.enabled !== "false",
        focusable: attrs.focusable === "true",
        scrollable: attrs.scrollable === "true",
        checked: attrs.checked === "true",
        selected: attrs.selected === "true",
        password: attrs.password === "true",
      });
    }
    if (!selfClosing) depth += 1;
  }
  const root = nodes[0];
  const display: Size = root ? { width: root.bounds.right - root.bounds.left, height: root.bounds.bottom - root.bounds.top } : { width: 0, height: 0 };
  const foreground = nodes.find(node => node.pkg !== "" && node.pkg !== "com.android.systemui" && area(node) > 0);
  return { display, package: foreground?.pkg ?? null, nodes };
}

function area(node: UiNode): number {
  return Math.max(0, node.bounds.right - node.bounds.left) * Math.max(0, node.bounds.bottom - node.bounds.top);
}

export function centerOf(node: UiNode): { x: number; y: number } {
  return { x: Math.round((node.bounds.left + node.bounds.right) / 2), y: Math.round((node.bounds.top + node.bounds.bottom) / 2) };
}

/** A node worth listing to a model: it says something or does something. */
export function isSignificant(node: UiNode): boolean {
  return node.text !== "" || node.desc !== "" || node.clickable || node.scrollable || (node.focusable && node.id !== "");
}

export type MatchTier = "exact" | "id" | "prefix" | "contains";
const TIER_RANK: Record<MatchTier, number> = { exact: 0, id: 1, prefix: 2, contains: 3 };

export interface LabelMatch {
  readonly node: UiNode;
  readonly tier: MatchTier;
}

const normalise = (value: string): string => value.trim().toLowerCase().replace(/\s+/g, " ");

function tierOf(node: UiNode, wanted: string): MatchTier | null {
  const text = normalise(node.text);
  const desc = normalise(node.desc);
  if (text === wanted || desc === wanted) return "exact";
  const id = node.id.toLowerCase();
  if (id !== "" && (id === wanted || id.endsWith(`/${wanted}`))) return "id";
  if ((text !== "" && text.startsWith(wanted)) || (desc !== "" && desc.startsWith(wanted))) return "prefix";
  if ((text !== "" && text.includes(wanted)) || (desc !== "" && desc.includes(wanted))) return "contains";
  return null;
}

/** Same spot: a clickable row and the label inside it are one tap target. */
const SAME_TARGET_PX = 12;

/**
 * Candidates for `label`, best first: the tier (exact text/description, then
 * resource id, then prefix, then contains), then clickable controls before plain
 * views, then reading order. Only enabled views that are on screen can be tapped.
 * Two nodes whose centres coincide are one target (the better one is kept).
 */
export function findByLabel(snapshot: UiSnapshot, label: string): LabelMatch[] {
  const wanted = normalise(label);
  if (wanted === "") return [];
  const { width, height } = snapshot.display;
  const found: LabelMatch[] = [];
  for (const node of snapshot.nodes) {
    if (!node.enabled || area(node) === 0) continue;
    const { x, y } = centerOf(node);
    if (x < 0 || y < 0 || (width > 0 && x >= width) || (height > 0 && y >= height)) continue;
    const tier = tierOf(node, wanted);
    if (tier !== null) found.push({ node, tier });
  }
  found.sort((a, b) => TIER_RANK[a.tier] - TIER_RANK[b.tier] || Number(b.node.clickable) - Number(a.node.clickable) || a.node.bounds.top - b.node.bounds.top || a.node.bounds.left - b.node.bounds.left);
  const unique: LabelMatch[] = [];
  for (const match of found) {
    const c = centerOf(match.node);
    const twin = unique.find(kept => {
      const k = centerOf(kept.node);
      return Math.abs(k.x - c.x) <= SAME_TARGET_PX && Math.abs(k.y - c.y) <= SAME_TARGET_PX;
    });
    if (twin === undefined) unique.push(match);
  }
  return unique;
}

/** A short, model-readable line for one node. */
export function describeNode(node: UiNode): string {
  const c = centerOf(node);
  const label = node.text !== "" ? `"${node.text}"` : node.desc !== "" ? `desc="${node.desc}"` : "";
  const flags = [node.clickable ? "clickable" : "", node.scrollable ? "scrollable" : "", node.checked ? "checked" : "", node.selected ? "selected" : "", node.password ? "password" : ""].filter(Boolean).join(",");
  const id = node.id.includes("/") ? node.id.slice(node.id.indexOf("/") + 1) : node.id;
  const cls = node.cls.slice(node.cls.lastIndexOf(".") + 1);
  return [`#${node.index}`, cls, label, id !== "" ? `id=${id}` : "", `@${c.x},${c.y}`, flags].filter(part => part !== "").join(" ");
}

import { Color } from "three";
import type { PartKind, Vibr } from "../model";

/**
 * The Stage paints with the host's own tokens. A canvas cannot resolve CSS,
 * so the colors are read off the document once per theme — the View imports
 * no kit, and `useHostStyles` (host mode) or `style.css` (preview) is what puts
 * the `--fr-*` values there in the first place.
 */
export interface StagePalette {
	readonly bg: Color;
	readonly text: Color;
	readonly accent: Color;
	readonly blue: Color;
	readonly iris: Color;
	readonly cyan: Color;
	readonly magenta: Color;
	readonly silver: Color;
}

function token(style: CSSStyleDeclaration, name: string, fallback: string): Color {
	const raw = style.getPropertyValue(name).trim();
	const color = new Color();
	try {
		color.setStyle(raw === "" ? fallback : raw);
	} catch {
		color.setStyle(fallback);
	}
	return color;
}

export function readPalette(root: Element = document.documentElement): StagePalette {
	const style = getComputedStyle(root);
	return {
		bg: token(style, "--fr-bg", "#0b0b0d"),
		text: token(style, "--fr-text", "#ececee"),
		accent: token(style, "--fr-accent", "#7a60c1"),
		blue: token(style, "--fr-blue", "#5b8cff"),
		iris: token(style, "--fr-iris", "#8f7bff"),
		// The two ends of Fraym's sanctioned aurora (`--fr-accent-grad-on`,
		// violet preset: #4f8cff → accent → #a060c0; blue preset opens on cyan).
		cyan: new Color("#43dcea"),
		magenta: new Color("#a060c0"),
		silver: token(style, "--fr-text-2-base", "#9a9aa2"),
	};
}

/** Each ring is one capability family; its hue is the family's only colour. */
export function ringColor(palette: StagePalette, kind: PartKind): Color {
	switch (kind) {
		case "tool":
			return palette.accent;
		case "skill":
			return palette.blue;
		case "mcp":
			return palette.iris;
		case "memory":
			return palette.cyan;
		case "lineage":
		case "model":
			return palette.silver;
	}
}

export type CoreShape = "sphere" | "icosa" | "box" | "octa";
export type CoreExtra = "none" | "cloud" | "disk" | "bands" | "grid" | "twins" | "shell";

/** How a vibr becomes a body. Every vibr is a point in this small space. */
export interface VibrStyle {
	readonly label: string;
	readonly hint: string;
	readonly shape: CoreShape;
	/** Surface displacement amplitude, frequency, and churn speed. */
	readonly amp: number;
	readonly freq: number;
	readonly speed: number;
	readonly wire: boolean;
	readonly extra: CoreExtra;
	/** Which two aurora hues the surface blends between. */
	readonly hues: readonly [keyof StagePalette, keyof StagePalette];
}

export const VIBR_STYLES: Record<Vibr, VibrStyle> = {
	blob: { label: "Blob", hint: "Soft, patient, always a little alive.", shape: "sphere", amp: 0.28, freq: 1.1, speed: 0.35, wire: false, extra: "none", hues: ["accent", "magenta"] },
	nebula: { label: "Nebula", hint: "A mind that gathers — dust orbiting a warm core.", shape: "sphere", amp: 0.12, freq: 1.8, speed: 0.25, wire: false, extra: "cloud", hues: ["accent", "cyan"] },
	quasar: { label: "Quasar", hint: "Focused output. Everything it takes in becomes a beam.", shape: "sphere", amp: 0.06, freq: 2.4, speed: 0.6, wire: false, extra: "disk", hues: ["cyan", "blue"] },
	lattice: { label: "Lattice", hint: "Structured, exact, reviewable.", shape: "icosa", amp: 0.04, freq: 1.2, speed: 0.2, wire: true, extra: "none", hues: ["blue", "iris"] },
	aurora: { label: "Aurora", hint: "Many currents braided into one.", shape: "sphere", amp: 0.1, freq: 1.4, speed: 0.3, wire: false, extra: "bands", hues: ["cyan", "accent"] },
	liquid: { label: "Liquid", hint: "Quick to reshape around the problem.", shape: "sphere", amp: 0.2, freq: 3.2, speed: 1.1, wire: false, extra: "none", hues: ["blue", "cyan"] },
	cube: { label: "Cube", hint: "A builder. Solid edges, stacked work.", shape: "box", amp: 0.05, freq: 1.6, speed: 0.3, wire: true, extra: "none", hues: ["iris", "accent"] },
	matrix: { label: "Matrix", hint: "Reads everything, lights up what it finds.", shape: "sphere", amp: 0.03, freq: 2.0, speed: 0.4, wire: false, extra: "grid", hues: ["cyan", "iris"] },
	static: { label: "Static", hint: "Signal in the noise — a listener.", shape: "sphere", amp: 0.08, freq: 6.0, speed: 2.4, wire: false, extra: "shell", hues: ["silver", "blue"] },
	siri: { label: "Siri", hint: "Three voices in one conversation.", shape: "sphere", amp: 0.14, freq: 1.3, speed: 0.5, wire: false, extra: "bands", hues: ["magenta", "cyan"] },
	koi: { label: "Koi", hint: "Two minds circling — a pair programmer.", shape: "sphere", amp: 0.1, freq: 1.5, speed: 0.4, wire: false, extra: "twins", hues: ["accent", "cyan"] },
	octo: { label: "Octo", hint: "Reaches into many places at once.", shape: "octa", amp: 0.09, freq: 1.9, speed: 0.45, wire: true, extra: "cloud", hues: ["magenta", "accent"] },
};

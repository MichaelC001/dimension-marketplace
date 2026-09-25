import {
	ACESFilmicToneMapping,
	AdditiveBlending,
	BufferAttribute,
	BufferGeometry,
	Clock,
	Group,
	IcosahedronGeometry,
	Line,
	LineBasicMaterial,
	LineDashedMaterial,
	LineLoop,
	LineSegments,
	type Material,
	Mesh,
	MeshBasicMaterial,
	OctahedronGeometry,
	Object3D,
	PerspectiveCamera,
	Plane,
	Points,
	PointsMaterial,
	Raycaster,
	Scene,
	SphereGeometry,
	TetrahedronGeometry,
	BoxGeometry,
	Vector2,
	Vector3,
	WebGLRenderer,
	EdgesGeometry,
	Color,
} from "three";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { OutputPass } from "three/examples/jsm/postprocessing/OutputPass.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
import { type AgentDraft, type Approval, type Habitat, type PartKind, type Satellite, satellitesOf, type Thinking, VIBRS, type Vibr } from "../model";
import { type AgentCore, createCore } from "./core";
import { readPalette, ringColor, type StagePalette, VIBR_STYLES } from "./palette";

// ── what the Stage is told to show ──────────────────────────────────────────

export interface OrbAgent {
	readonly key: string;
	readonly name: string;
	readonly description: string;
	readonly vibr: Vibr;
	readonly lineage: readonly string[];
	/** How much this agent carries — orbits drawn around its orb. */
	readonly rings: number;
}

export type StageScene =
	| { readonly mode: "constellation"; readonly agents: readonly OrbAgent[] }
	| { readonly mode: "forge"; readonly draft: AgentDraft; readonly vibr: Vibr; readonly picking: boolean };

export interface StageEvents {
	pickAgent(key: string): void;
	selectSatellite(satellite: Satellite | null): void;
	releaseSatellite(satellite: Satellite): void;
	thinkingStep(delta: 1 | -1): void;
	openVibr(): void;
	previewVibr(vibr: Vibr | null): void;
	pickVibr(vibr: Vibr): void;
}

export const NEW_AGENT_KEY = "__forge_new__";
/** Resting bloom strength; a warp between scenes flares it and settles back. */
const BLOOM = 0.62;
/** Points per lineage arc. */
const ARC_SEGMENTS = 40;

const ENERGY: Record<Thinking, number> = { inherit: 0.35, off: 0.05, minimal: 0.15, low: 0.3, medium: 0.5, high: 0.75, xhigh: 1 };

/** Ring geometry per capability family: radius, tilt, orbit speed (rad/s). */
const RINGS: Record<Exclude<PartKind, "model">, { radius: number; tiltX: number; tiltZ: number; speed: number; label: string }> = {
	tool: { radius: 2.2, tiltX: 0.34, tiltZ: 0.16, speed: 0.22, label: "Tools" },
	skill: { radius: 2.75, tiltX: 0.22, tiltZ: -0.2, speed: 0.15, label: "Skills" },
	mcp: { radius: 3.25, tiltX: 0.46, tiltZ: 0.3, speed: 0.11, label: "MCP" },
	memory: { radius: 3.75, tiltX: 0.12, tiltZ: -0.06, speed: 0.06, label: "Memory" },
	lineage: { radius: 4.35, tiltX: 0.3, tiltZ: 0.1, speed: 0.04, label: "Lineage" },
};
type RingKind = keyof typeof RINGS;
const RING_KINDS = Object.keys(RINGS) as RingKind[];

const easeOutExpo = (t: number) => (t >= 1 ? 1 : 1 - 2 ** (-10 * t));
const easeInCubic = (t: number) => t * t * t;

interface Tween {
	elapsed: number;
	readonly duration: number;
	readonly ease: (t: number) => number;
	readonly apply: (k: number) => void;
	readonly done?: () => void;
}

interface SatelliteNode {
	readonly satellite: Satellite;
	readonly mesh: Mesh;
	readonly label: HTMLDivElement;
	angle: number;
	targetAngle: number;
	/** 0→1 arrival from its drop point; 1 = in orbit. */
	arrival: number;
	readonly from: Vector3 | null;
	beam: Line | null;
	leaving: boolean;
}

interface OrbNode {
	readonly agent: OrbAgent;
	readonly core: AgentCore;
	readonly anchor: Group;
	readonly label: HTMLDivElement;
	readonly position: Vector3;
}

function disposeTree(root: Object3D) {
	root.traverse(object => {
		const withGeometry = object as Mesh;
		withGeometry.geometry?.dispose();
		const material = (object as Mesh).material as Material | Material[] | undefined;
		if (Array.isArray(material)) for (const m of material) m.dispose();
		else material?.dispose();
	});
}

function circlePoints(radius: number, segments: number): BufferGeometry {
	const positions = new Float32Array(segments * 3);
	for (let i = 0; i < segments; i++) {
		const a = (i / segments) * Math.PI * 2;
		positions[i * 3] = Math.cos(a) * radius;
		positions[i * 3 + 2] = Math.sin(a) * radius;
	}
	const geometry = new BufferGeometry();
	geometry.setAttribute("position", new BufferAttribute(positions, 3));
	return geometry;
}

/**
 * The Forge's 3D stage — an orrery. The agent's mind is the core; every
 * capability family is one orbit; every attached part is a body on its orbit.
 * React owns the document; this class owns pixels and pointer physics only,
 * and reports gestures back through {@link StageEvents}.
 */
export class Stage {
	private readonly renderer: WebGLRenderer;
	private readonly composer: EffectComposer;
	private readonly bloom: UnrealBloomPass;
	private readonly scene = new Scene();
	private readonly camera = new PerspectiveCamera(42, 1, 0.1, 400);
	private readonly clock = new Clock();
	private readonly raycaster = new Raycaster();
	private readonly pointer = new Vector2(0, 0);
	private readonly parallax = new Vector2(0, 0);
	private readonly tweens: Tween[] = [];
	private readonly reducedMotion: boolean;
	private palette: StagePalette;
	private frame = 0;
	private disposed = false;

	private root = new Group();
	private sceneState: StageScene | null = null;
	private cameraGoal = { position: new Vector3(0, 7.2, 13.5), target: new Vector3(0, -0.4, 0) };
	private readonly cameraTarget = new Vector3(0, 0, 0);

	// forge state
	private core: AgentCore | null = null;
	private coreVibr: Vibr | null = null;
	private readonly coreHolder = new Group();
	private readonly ringGroups = new Map<RingKind, { pivot: Group; spin: Group; line: LineLoop; material: LineBasicMaterial; label: HTMLDivElement }>();
	private readonly satellites = new Map<string, SatelliteNode>();
	private memoryBand: Points | null = null;
	private gateField: LineSegments | null = null;
	private gateLevel: Approval | null = null;
	private habitat: Group | null = null;
	private habitatKind: Habitat | null = null;
	private energy = 0.35;
	private dragKind: PartKind | null = null;
	private readonly pendingDrops = new Map<string, Vector3>();
	private selectedKey: string | null = null;
	private vibrWheel: { group: Group; options: { vibr: Vibr; core: AgentCore; label: HTMLDivElement }[] } | null = null;

	// constellation state
	private readonly orbs = new Map<string, OrbNode>();
	private seed: { group: Group; hit: Mesh; label: HTMLDivElement } | null = null;
	private lineage: { line: Line; pulse: Mesh; from: Vector3; to: Vector3; phase: number }[] = [];
	private hoverKey: string | null = null;

	// gestures
	private gesture:
		| { kind: "thinking"; startY: number; steps: number }
		| { kind: "satellite"; key: string; startX: number; startY: number; moved: boolean }
		| { kind: "press"; startX: number; startY: number }
		| null = null;

	private readonly starfield: Points;

	constructor(
		private readonly canvas: HTMLCanvasElement,
		private readonly overlay: HTMLDivElement,
		private readonly events: StageEvents,
	) {
		this.reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
		this.palette = readPalette();
		this.renderer = new WebGLRenderer({ canvas, antialias: true, powerPreference: "high-performance" });
		this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
		this.renderer.toneMapping = ACESFilmicToneMapping;
		this.renderer.toneMappingExposure = 1.05;
		this.scene.background = this.palette.bg.clone();

		this.composer = new EffectComposer(this.renderer);
		this.composer.addPass(new RenderPass(this.scene, this.camera));
		this.bloom = new UnrealBloomPass(new Vector2(256, 256), BLOOM, 0.5, 0.2);
		this.composer.addPass(this.bloom);
		this.composer.addPass(new OutputPass());

		this.starfield = this.buildStarfield();
		this.scene.add(this.starfield);
		this.scene.add(this.root);
		this.camera.position.copy(this.cameraGoal.position);

		canvas.addEventListener("pointermove", this.onPointerMove);
		canvas.addEventListener("pointerdown", this.onPointerDown);
		canvas.addEventListener("pointerup", this.onPointerUp);
		canvas.addEventListener("pointerleave", this.onPointerLeave);
		canvas.addEventListener("dblclick", this.onDoubleClick);
		document.addEventListener("visibilitychange", this.onVisibility);
		this.resizeObserver.observe(canvas.parentElement ?? canvas);
		this.resize();
		this.frame = requestAnimationFrame(this.loop);
	}

	// ── public API ────────────────────────────────────────────────────────────

	setScene(next: StageScene) {
		const previous = this.sceneState;
		this.sceneState = next;
		if (previous === null || previous.mode !== next.mode) {
			this.warpTo(next);
			return;
		}
		if (next.mode === "forge") this.reconcileForge(next);
		else this.reconcileConstellation(next);
	}

	/** A part is being dragged over the canvas — light the orbit it belongs to. */
	setDragKind(kind: PartKind | null) {
		this.dragKind = kind;
	}

	/** Remember where a part was dropped so its body flies from there into orbit. */
	markDrop(kind: PartKind, id: string, clientX: number, clientY: number) {
		const point = this.planePoint(clientX, clientY);
		if (point) this.pendingDrops.set(`${kind}:${id}`, point);
	}

	setSelected(satellite: Satellite | null) {
		this.selectedKey = satellite ? `${satellite.kind}:${satellite.id}` : null;
		for (const [key, node] of this.satellites) node.label.classList.toggle("is-selected", key === this.selectedKey);
	}

	/** Theme changed on the host — repaint with the new tokens. */
	refreshPalette() {
		this.palette = readPalette();
		this.scene.background = this.palette.bg.clone();
		const current = this.sceneState;
		if (current === null) return;
		this.sceneState = null;
		this.clearRoot();
		this.setScene(current);
	}

	dispose() {
		this.disposed = true;
		cancelAnimationFrame(this.frame);
		this.resizeObserver.disconnect();
		this.canvas.removeEventListener("pointermove", this.onPointerMove);
		this.canvas.removeEventListener("pointerdown", this.onPointerDown);
		this.canvas.removeEventListener("pointerup", this.onPointerUp);
		this.canvas.removeEventListener("pointerleave", this.onPointerLeave);
		this.canvas.removeEventListener("dblclick", this.onDoubleClick);
		document.removeEventListener("visibilitychange", this.onVisibility);
		this.clearRoot();
		disposeTree(this.scene);
		this.composer.dispose();
		this.renderer.dispose();
	}

	// ── scene switching ───────────────────────────────────────────────────────

	private warpTo(next: StageScene) {
		const outgoing = this.root;
		const outgoingLabels = [...this.overlay.children] as HTMLElement[];
		this.root = new Group();
		this.scene.add(this.root);
		this.resetState();

		if (next.mode === "forge") {
			this.buildForge();
			this.reconcileForge(next);
			this.cameraGoal = { position: new Vector3(0, 3.6, 13.8), target: new Vector3(0, -0.2, 0) };
		} else {
			this.reconcileConstellation(next);
			this.cameraGoal = { position: new Vector3(0, 7.2, 13.5), target: new Vector3(0, -0.4, 0) };
		}

		if (outgoing.children.length === 0 || this.reducedMotion) {
			this.scene.remove(outgoing);
			disposeTree(outgoing);
			for (const label of outgoingLabels) label.remove();
			return;
		}
		for (const label of outgoingLabels) label.classList.add("is-leaving");
		this.root.scale.setScalar(0.35);
		const incoming = this.root;
		this.tween(420, easeInCubic, k => {
			outgoing.scale.setScalar(1 + k * 1.6);
			this.bloom.strength = BLOOM + k * 1.2;
		}, () => {
			this.scene.remove(outgoing);
			disposeTree(outgoing);
			for (const label of outgoingLabels) label.remove();
			this.tween(900, easeOutExpo, k => {
				incoming.scale.setScalar(0.35 + 0.65 * k);
				this.bloom.strength = BLOOM + 1.2 * (1 - k);
			});
		});
	}

	private resetState() {
		this.core = null;
		this.coreVibr = null;
		this.ringGroups.clear();
		this.satellites.clear();
		this.memoryBand = null;
		this.gateField = null;
		this.gateLevel = null;
		this.habitat = null;
		this.habitatKind = null;
		this.vibrWheel = null;
		this.orbs.clear();
		this.seed = null;
		this.lineage = [];
		this.hoverKey = null;
		this.selectedKey = null;
	}

	private clearRoot() {
		this.scene.remove(this.root);
		disposeTree(this.root);
		this.root = new Group();
		this.scene.add(this.root);
		this.overlay.replaceChildren();
		this.resetState();
	}

	private label(className: string, text: string, sub?: string): HTMLDivElement {
		const element = document.createElement("div");
		element.className = `fg-label ${className}`;
		const title = document.createElement("span");
		title.className = "fg-label-title";
		title.textContent = text;
		element.append(title);
		if (sub !== undefined) {
			const detail = document.createElement("span");
			detail.className = "fg-label-sub";
			detail.textContent = sub;
			element.append(detail);
		}
		this.overlay.append(element);
		return element;
	}

	// ── forge ───────────────────────────────────────────────────────────────

	private buildForge() {
		this.coreHolder.clear();
		this.root.add(this.coreHolder);
		for (const kind of RING_KINDS) {
			const spec = RINGS[kind];
			const pivot = new Group();
			pivot.rotation.set(spec.tiltX, 0, spec.tiltZ);
			const spin = new Group();
			pivot.add(spin);
			const material = new LineBasicMaterial({ color: ringColor(this.palette, kind), transparent: true, opacity: 0.16, blending: AdditiveBlending, depthWrite: false });
			const line = new LineLoop(circlePoints(spec.radius, 256), material);
			pivot.add(line);
			this.root.add(pivot);
			const label = this.label("fg-ring-label", spec.label);
			label.dataset.kind = kind;
			this.ringGroups.set(kind, { pivot, spin, line, material, label });
		}
	}

	private reconcileForge(next: Extract<StageScene, { mode: "forge" }>) {
		const { draft } = next;
		if (this.coreVibr !== next.vibr) this.swapCore(next.vibr);
		this.energy = ENERGY[draft.thinking];
		this.core?.setEnergy(this.energy);
		this.reconcileGate(draft.approval);
		this.reconcileHabitat(draft.habitat);
		this.reconcileSatellites(satellitesOf(draft), draft);
		this.reconcileVibrWheel(next.picking, next.vibr);
	}

	private swapCore(vibr: Vibr) {
		const old = this.core;
		const fresh = createCore(vibr, this.palette, 1);
		this.core = fresh;
		this.coreVibr = vibr;
		this.coreHolder.add(fresh.group);
		fresh.setEnergy(this.energy);
		if (old === null || this.reducedMotion) {
			if (old) {
				this.coreHolder.remove(old.group);
				old.dispose();
			}
			return;
		}
		fresh.group.scale.setScalar(0.01);
		this.tween(520, easeOutExpo, k => {
			fresh.group.scale.setScalar(Math.max(0.01, k));
			old.group.scale.setScalar(Math.max(0.01, 1 - k));
		}, () => {
			this.coreHolder.remove(old.group);
			old.dispose();
		});
	}

	private reconcileGate(level: Approval) {
		if (this.gateLevel === level) return;
		this.gateLevel = level;
		if (this.gateField) {
			this.root.remove(this.gateField);
			disposeTree(this.gateField);
			this.gateField = null;
		}
		if (level === "yolo") return;
		// The containment field IS the approval gate: a dense cage asks before
		// everything, a sparse one only before writes, none at all runs free.
		const geometry = new EdgesGeometry(new IcosahedronGeometry(1.85, level === "always-ask" ? 1 : 0));
		const material = new LineBasicMaterial({ color: this.palette.silver, transparent: true, opacity: level === "always-ask" ? 0.16 : 0.1, blending: AdditiveBlending, depthWrite: false });
		this.gateField = new LineSegments(geometry, material);
		this.root.add(this.gateField);
	}

	private reconcileHabitat(kind: Habitat) {
		if (this.habitatKind === kind) return;
		this.habitatKind = kind;
		if (this.habitat) {
			this.root.remove(this.habitat);
			disposeTree(this.habitat);
		}
		const group = new Group();
		group.position.y = -3.4;
		const color = this.palette.silver;
		if (kind === "ephemeral") {
			const material = new LineDashedMaterial({ color, dashSize: 0.12, gapSize: 0.16, transparent: true, opacity: 0.5 });
			const ring = new LineLoop(circlePoints(0.9, 96), material);
			ring.computeLineDistances();
			group.add(ring);
		} else {
			group.add(new LineLoop(circlePoints(0.9, 96), new LineBasicMaterial({ color, transparent: true, opacity: 0.32 })));
			if (kind === "home") group.add(new LineLoop(circlePoints(1.15, 96), new LineBasicMaterial({ color: this.palette.cyan, transparent: true, opacity: 0.4 })));
			// The tether: a bound agent hangs from the workspace it was opened in.
			const tether = new BufferGeometry();
			tether.setAttribute("position", new BufferAttribute(new Float32Array([0, 0, 0, 0, 2.05, 0]), 3));
			group.add(new Line(tether, new LineBasicMaterial({ color, transparent: true, opacity: 0.35 })));
		}
		this.habitat = group;
		this.root.add(group);
	}

	private satelliteMesh(kind: PartKind): Mesh {
		// Silver bodies (lineage) would bloom to white at the same gain.
		const color = ringColor(this.palette, kind).clone().multiplyScalar(kind === "lineage" || kind === "model" ? 0.75 : 1.6);
		const material = new MeshBasicMaterial({ color });
		switch (kind) {
			case "tool":
				return new Mesh(new OctahedronGeometry(0.13), material);
			case "skill":
				return new Mesh(new TetrahedronGeometry(0.15), material);
			case "mcp":
				return new Mesh(new BoxGeometry(0.17, 0.17, 0.17), material);
			case "memory":
				return new Mesh(new SphereGeometry(0.16, 24, 24), material);
			case "lineage":
			case "model":
				return new Mesh(new IcosahedronGeometry(0.17, 2), material);
		}
	}

	private reconcileSatellites(wanted: Satellite[], draft: AgentDraft) {
		const wantedKeys = new Set(wanted.map(s => `${s.kind}:${s.id}`));
		for (const [key, node] of this.satellites) {
			if (wantedKeys.has(key) || node.leaving) continue;
			node.leaving = true;
			node.label.classList.add("is-leaving");
			const start = node.mesh.position.clone();
			const outward = start.clone().normalize().multiplyScalar(6);
			this.tween(this.reducedMotion ? 1 : 650, easeInCubic, k => {
				node.mesh.position.lerpVectors(start, start.clone().add(outward), k);
				node.mesh.scale.setScalar(Math.max(0.01, 1 - k));
			}, () => {
				node.mesh.parent?.remove(node.mesh);
				node.beam?.parent?.remove(node.beam);
				disposeTree(node.mesh);
				if (node.beam) disposeTree(node.beam);
				node.label.remove();
				this.satellites.delete(key);
			});
		}
		for (const satellite of wanted) {
			const key = `${satellite.kind}:${satellite.id}`;
			if (this.satellites.has(key)) continue;
			const ringKind = satellite.kind as RingKind;
			const ring = this.ringGroups.get(ringKind);
			if (!ring) continue;
			const mesh = this.satelliteMesh(satellite.kind);
			ring.spin.add(mesh);
			const from = this.pendingDrops.get(key) ?? null;
			this.pendingDrops.delete(key);
			const label = this.label(`fg-sat-label is-${satellite.kind}`, satellite.id);
			let beam: Line | null = null;
			if (satellite.kind === "lineage") {
				const geometry = new BufferGeometry();
				geometry.setAttribute("position", new BufferAttribute(new Float32Array(6), 3));
				beam = new Line(geometry, new LineBasicMaterial({ color: this.palette.silver, transparent: true, opacity: 0.3, blending: AdditiveBlending, depthWrite: false }));
				this.root.add(beam);
			}
			this.satellites.set(key, { satellite, mesh, label, angle: 0, targetAngle: 0, arrival: from ? 0 : 1, from, beam, leaving: false });
			if (from && !this.reducedMotion) {
				const node = this.satellites.get(key);
				if (node) this.tween(1100, easeOutExpo, k => { node.arrival = k; });
			} else {
				const node = this.satellites.get(key);
				if (node) node.arrival = 1;
			}
		}
		// Even spacing per orbit; existing bodies glide to their new slots.
		for (const kind of RING_KINDS) {
			const onRing = [...this.satellites.values()].filter(node => node.satellite.kind === kind && !node.leaving);
			onRing.forEach((node, index) => {
				node.targetAngle = (index / Math.max(1, onRing.length)) * Math.PI * 2;
				if (node.arrival === 0 || node.from) node.angle = node.targetAngle;
			});
		}
		this.reconcileMemoryBand(draft);
	}

	private reconcileMemoryBand(draft: AgentDraft) {
		const on = draft.memory !== "inherit" && draft.memory !== "off";
		if (on === (this.memoryBand !== null)) return;
		const ring = this.ringGroups.get("memory");
		if (!ring) return;
		if (!on && this.memoryBand) {
			ring.spin.remove(this.memoryBand);
			disposeTree(this.memoryBand);
			this.memoryBand = null;
			return;
		}
		const count = 2400;
		const positions = new Float32Array(count * 3);
		let s = 42;
		const rand = () => {
			s = (s * 16807) % 2147483647;
			return (s - 1) / 2147483646;
		};
		for (let i = 0; i < count; i++) {
			const a = rand() * Math.PI * 2;
			const r = RINGS.memory.radius + (rand() - 0.5) * 0.35;
			positions[i * 3] = Math.cos(a) * r;
			positions[i * 3 + 1] = (rand() - 0.5) * 0.12;
			positions[i * 3 + 2] = Math.sin(a) * r;
		}
		const geometry = new BufferGeometry();
		geometry.setAttribute("position", new BufferAttribute(positions, 3));
		this.memoryBand = new Points(geometry, new PointsMaterial({ color: this.palette.cyan, size: 0.028, transparent: true, opacity: 0.8, blending: AdditiveBlending, depthWrite: false }));
		ring.spin.add(this.memoryBand);
	}

	private reconcileVibrWheel(picking: boolean, current: Vibr) {
		if (picking === (this.vibrWheel !== null)) {
			if (this.vibrWheel) for (const option of this.vibrWheel.options) option.label.classList.toggle("is-current", option.vibr === current);
			return;
		}
		// The wheel is the whole stage while it is open: orbits and their names step back.
		for (const ring of this.ringGroups.values()) ring.pivot.visible = !picking;
		this.overlay.classList.toggle("is-picking", picking);
		if (!picking && this.vibrWheel) {
			const wheel = this.vibrWheel;
			this.vibrWheel = null;
			for (const option of wheel.options) option.label.remove();
			this.tween(this.reducedMotion ? 1 : 320, easeInCubic, k => wheel.group.scale.setScalar(Math.max(0.01, 1 - k)), () => {
				this.root.remove(wheel.group);
				for (const option of wheel.options) option.core.dispose();
			});
			return;
		}
		const group = new Group();
		const options = VIBRS.map((vibr, index) => {
			const core = createCore(vibr, this.palette, 0.3);
			const angle = (index / VIBRS.length) * Math.PI * 2 + Math.PI / 2;
			core.group.position.set(Math.cos(angle) * 3.7, 0.7 + Math.sin(angle) * 2.3, 1.2);
			core.group.userData.vibr = vibr;
			group.add(core.group);
			const label = this.label("fg-vibr-label", VIBR_STYLES[vibr].label);
			label.classList.toggle("is-current", vibr === current);
			return { vibr, core, label };
		});
		group.scale.setScalar(0.01);
		this.root.add(group);
		this.vibrWheel = { group, options };
		this.tween(this.reducedMotion ? 1 : 700, easeOutExpo, k => group.scale.setScalar(Math.max(0.01, k)));
	}

	// ── constellation ──────────────────────────────────────────────────────

	private reconcileConstellation(next: Extract<StageScene, { mode: "constellation" }>) {
		const wanted = new Map(next.agents.map(agent => [agent.key, agent]));
		for (const [key, orb] of this.orbs) {
			const agent = wanted.get(key);
			if (agent && agent.vibr === orb.agent.vibr && agent.name === orb.agent.name && agent.rings === orb.agent.rings) continue;
			this.root.remove(orb.anchor);
			disposeTree(orb.anchor);
			orb.core.dispose();
			orb.label.remove();
			this.orbs.delete(key);
		}
		const count = next.agents.length;
		next.agents.forEach((agent, index) => {
			// Up to ten minds share one orbit around the seed; beyond that a
			// golden-angle spiral keeps forty just as calm.
			const onOrbit = count <= 10;
			const angle = onOrbit ? (index / count) * Math.PI * 2 + 0.4 : index * 2.39996 + 0.6;
			const radius = onOrbit ? 5.6 : 4.4 + 1.9 * Math.sqrt(index);
			const slot = new Vector3(Math.cos(angle) * radius, index % 2 === 0 ? 0.35 : -0.35, Math.sin(angle) * radius * 0.85);
			const existing = this.orbs.get(agent.key);
			if (existing) {
				existing.position.copy(slot);
				return;
			}
			const anchor = new Group();
			anchor.position.copy(slot);
			const core = createCore(agent.vibr, this.palette, 0.42);
			anchor.add(core.group);
			for (let r = 0; r < Math.min(agent.rings, 4); r++) {
				const ring = new LineLoop(circlePoints(0.95 + r * 0.22, 96), new LineBasicMaterial({ color: this.palette.silver, transparent: true, opacity: 0.22, blending: AdditiveBlending, depthWrite: false }));
				ring.rotation.set(1.2 + r * 0.25, 0, r * 0.4);
				anchor.add(ring);
			}
			this.root.add(anchor);
			const label = this.label("fg-orb-label", agent.name, agent.description);
			this.orbs.set(agent.key, { agent, core, anchor, label, position: slot });
		});
		if (this.seed === null) this.buildSeed();
		this.rebuildLineage();
	}

	private buildSeed() {
		const group = new Group();
		const shell = new LineSegments(new EdgesGeometry(new IcosahedronGeometry(0.7, 1)), new LineDashedMaterial({ color: this.palette.accent, dashSize: 0.06, gapSize: 0.05, transparent: true, opacity: 0.9 }));
		shell.computeLineDistances();
		group.add(shell);
		const spark = new Mesh(new SphereGeometry(0.12, 24, 24), new MeshBasicMaterial({ color: this.palette.accent.clone().multiplyScalar(2) }));
		group.add(spark);
		const hit = new Mesh(new SphereGeometry(1, 12, 12), new MeshBasicMaterial({ visible: false }));
		group.add(hit);
		this.root.add(group);
		this.seed = { group, hit, label: this.label("fg-seed-label", "Forge a new agent") };
	}

	private rebuildLineage() {
		for (const link of this.lineage) {
			this.root.remove(link.line, link.pulse);
			disposeTree(link.line);
			disposeTree(link.pulse);
		}
		this.lineage = [];
		const byName = new Map([...this.orbs.values()].map(orb => [orb.agent.name, orb]));
		for (const orb of this.orbs.values()) {
			for (const parent of orb.agent.lineage) {
				const base = byName.get(parent);
				if (!base) continue;
				const geometry = new BufferGeometry();
				geometry.setAttribute("position", new BufferAttribute(new Float32Array(ARC_SEGMENTS * 3), 3));
				const line = new Line(geometry, new LineBasicMaterial({ color: this.palette.silver, transparent: true, opacity: 0.28, blending: AdditiveBlending, depthWrite: false }));
				const pulse = new Mesh(new SphereGeometry(0.05, 12, 12), new MeshBasicMaterial({ color: this.palette.text }));
				this.root.add(line, pulse);
				this.lineage.push({ line, pulse, from: base.anchor.position, to: orb.anchor.position, phase: Math.random() });
			}
		}
	}

	// ── frame loop ────────────────────────────────────────────────────────────

	private readonly loop = () => {
		if (this.disposed) return;
		this.frame = requestAnimationFrame(this.loop);
		if (document.visibilityState === "hidden") return;
		const dt = Math.min(this.clock.getDelta(), 0.05);
		const time = this.clock.elapsedTime;
		const motion = this.reducedMotion ? 0 : 1;

		for (let i = this.tweens.length - 1; i >= 0; i--) {
			const tween = this.tweens[i];
			if (!tween) continue;
			tween.elapsed += dt * 1000;
			const k = Math.min(1, tween.elapsed / tween.duration);
			tween.apply(tween.ease(k));
			if (k >= 1) {
				this.tweens.splice(i, 1);
				tween.done?.();
			}
		}

		// Camera: ease toward the goal, lean with the pointer.
		this.parallax.lerp(this.pointer, 0.04);
		const goal = this.cameraGoal.position.clone().add(new Vector3(this.parallax.x * 1.1 * motion, this.parallax.y * 0.6 * motion, 0));
		this.camera.position.lerp(goal, this.reducedMotion ? 1 : 0.05);
		this.cameraTarget.lerp(this.cameraGoal.target, this.reducedMotion ? 1 : 0.06);
		this.camera.lookAt(this.cameraTarget);
		this.starfield.rotation.y += dt * 0.006 * motion;

		if (this.sceneState?.mode === "forge") this.tickForge(time, dt * motion);
		else this.tickConstellation(time, dt * motion);

		this.composer.render();
	};

	private tickForge(time: number, dt: number) {
		this.core?.tick(time, dt);
		const tmp = new Vector3();
		for (const [kind, ring] of this.ringGroups) {
			ring.spin.rotation.y += RINGS[kind].speed * dt;
			const count = [...this.satellites.values()].filter(node => node.satellite.kind === kind && !node.leaving).length;
			const targeted = this.dragKind === kind;
			const goal = targeted ? 0.95 : count > 0 ? 0.38 : 0.14;
			ring.material.opacity += (goal - ring.material.opacity) * 0.12;
			const pulse = targeted ? 1 + Math.sin(time * 6) * 0.015 : 1;
			ring.line.scale.setScalar(pulse);
			ring.label.classList.toggle("is-targeted", targeted);
			ring.label.classList.toggle("is-empty", count === 0);
			// Name each orbit at its outer edge, alternating sides so the names
			// never stack on one another.
			const side = RING_KINDS.indexOf(kind) % 2 === 0 ? 1 : -1;
			tmp.set(RINGS[kind].radius * side, 0, 0);
			ring.pivot.localToWorld(tmp);
			this.place(ring.label, tmp, side === 1 ? "after" : "before");
		}
		for (const [key, node] of this.satellites) {
			if (node.leaving) continue;
			node.angle += (node.targetAngle - node.angle) * 0.08;
			const radius = RINGS[node.satellite.kind as RingKind].radius;
			const orbit = new Vector3(Math.cos(node.angle) * radius, 0, Math.sin(node.angle) * radius);
			if (node.arrival < 1 && node.from && node.mesh.parent) {
				const local = node.mesh.parent.worldToLocal(node.from.clone());
				node.mesh.position.lerpVectors(local, orbit, node.arrival);
				node.mesh.scale.setScalar(0.4 + 0.6 * node.arrival + (1 - node.arrival) * 1.6);
			} else {
				node.mesh.position.copy(orbit);
				const selected = key === this.selectedKey;
				node.mesh.scale.setScalar(selected ? 1.5 + Math.sin(time * 5) * 0.12 : 1);
			}
			node.mesh.rotation.x += dt * 0.8;
			node.mesh.rotation.y += dt * 1.1;
			node.mesh.getWorldPosition(tmp);
			this.place(node.label, tmp);
			if (node.beam) {
				const positions = node.beam.geometry.getAttribute("position") as BufferAttribute;
				positions.setXYZ(0, 0, 0, 0);
				positions.setXYZ(1, tmp.x, tmp.y, tmp.z);
				positions.needsUpdate = true;
			}
		}
		if (this.gateField) {
			this.gateField.rotation.y -= dt * 0.05;
			this.gateField.rotation.x += dt * 0.02;
		}
		if (this.vibrWheel) {
			this.vibrWheel.group.rotation.z = Math.sin(time * 0.2) * 0.03;
			for (const option of this.vibrWheel.options) {
				option.core.tick(time, dt);
				option.core.group.getWorldPosition(tmp);
				tmp.y -= 0.72;
				this.place(option.label, tmp);
			}
		}
	}

	private tickConstellation(time: number, dt: number) {
		this.root.rotation.y += dt * 0.025;
		const tmp = new Vector3();
		for (const [key, orb] of this.orbs) {
			orb.core.tick(time, dt);
			const hovered = key === this.hoverKey;
			const scale = orb.anchor.scale.x + ((hovered ? 1.35 : 1) - orb.anchor.scale.x) * 0.12;
			orb.anchor.scale.setScalar(scale);
			orb.anchor.position.x += (orb.position.x - orb.anchor.position.x) * 0.08;
			orb.anchor.position.z += (orb.position.z - orb.anchor.position.z) * 0.08;
			orb.anchor.position.y = orb.position.y + Math.sin(time * 0.6 + orb.position.x) * 0.08;
			orb.anchor.getWorldPosition(tmp);
			tmp.y -= 0.85 * scale;
			this.place(orb.label, tmp);
			orb.label.classList.toggle("is-hovered", hovered);
		}
		if (this.seed) {
			const hovered = this.hoverKey === NEW_AGENT_KEY;
			this.seed.group.rotation.y += dt * 0.4;
			this.seed.group.rotation.x += dt * 0.15;
			const s = (hovered ? 1.25 : 1) + Math.sin(time * 2.2) * 0.05;
			this.seed.group.scale.setScalar(s);
			this.seed.group.getWorldPosition(tmp);
			tmp.y -= 1.05;
			this.place(this.seed.label, tmp);
			this.seed.label.classList.toggle("is-hovered", hovered);
		}
		// Lineage arcs over the field rather than cutting through it: a quadratic
		// curve lifted at its midpoint, re-sampled as its ends glide.
		const control = new Vector3();
		const arcPoint = (link: (typeof this.lineage)[number], t: number, out: Vector3) => {
			control.addVectors(link.from, link.to).multiplyScalar(0.5);
			control.y += 1.6 + link.from.distanceTo(link.to) * 0.18;
			const u = 1 - t;
			return out.set(0, 0, 0).addScaledVector(link.from, u * u).addScaledVector(control, 2 * u * t).addScaledVector(link.to, t * t);
		};
		for (const link of this.lineage) {
			const positions = link.line.geometry.getAttribute("position") as BufferAttribute;
			for (let i = 0; i < ARC_SEGMENTS; i++) {
				arcPoint(link, i / (ARC_SEGMENTS - 1), tmp);
				positions.setXYZ(i, tmp.x, tmp.y, tmp.z);
			}
			positions.needsUpdate = true;
			arcPoint(link, (time * 0.22 + link.phase) % 1, link.pulse.position);
		}
	}

	/** Pin an overlay label to a world position (hidden when behind the camera). */
	private place(element: HTMLElement, world: Vector3, align: "below" | "after" | "before" = "below") {
		const projected = world.clone().project(this.camera);
		if (projected.z > 1) {
			element.style.opacity = "0";
			return;
		}
		const x = (projected.x * 0.5 + 0.5) * this.width;
		const y = (-projected.y * 0.5 + 0.5) * this.height;
		const shift = align === "below" ? "translate(-50%, 0)" : align === "after" ? "translate(10px, -50%)" : "translate(calc(-100% - 10px), -50%)";
		element.style.transform = `translate3d(${x.toFixed(1)}px, ${y.toFixed(1)}px, 0) ${shift}`;
		element.style.opacity = "";
	}

	private buildStarfield(): Points {
		const count = 2200;
		const positions = new Float32Array(count * 3);
		let s = 99;
		const rand = () => {
			s = (s * 16807) % 2147483647;
			return (s - 1) / 2147483646;
		};
		for (let i = 0; i < count; i++) {
			const theta = rand() * Math.PI * 2;
			const phi = Math.acos(2 * rand() - 1);
			const r = 45 + rand() * 60;
			positions[i * 3] = r * Math.sin(phi) * Math.cos(theta);
			positions[i * 3 + 1] = r * Math.cos(phi);
			positions[i * 3 + 2] = r * Math.sin(phi) * Math.sin(theta);
		}
		const geometry = new BufferGeometry();
		geometry.setAttribute("position", new BufferAttribute(positions, 3));
		return new Points(geometry, new PointsMaterial({ color: new Color(this.palette.silver).multiplyScalar(0.8), size: 0.16, transparent: true, opacity: 0.55, depthWrite: false }));
	}

	private tween(duration: number, ease: (t: number) => number, apply: (k: number) => void, done?: () => void) {
		this.tweens.push({ elapsed: 0, duration: Math.max(1, duration), ease, apply, done });
	}

	// ── pointer physics ───────────────────────────────────────────────────────

	private width = 1;
	private height = 1;
	private readonly resizeObserver = new ResizeObserver(() => this.resize());

	private resize() {
		const host = this.canvas.parentElement ?? this.canvas;
		this.width = Math.max(1, host.clientWidth);
		this.height = Math.max(1, host.clientHeight);
		this.renderer.setSize(this.width, this.height, false);
		this.composer.setSize(this.width, this.height);
		this.bloom.resolution.set(this.width / 2, this.height / 2);
		this.camera.aspect = this.width / this.height;
		// Keep the whole orrery in frame on narrow panes.
		this.camera.fov = this.camera.aspect < 1 ? 58 : 42;
		this.camera.updateProjectionMatrix();
	}

	private ndc(clientX: number, clientY: number): Vector2 {
		const rect = this.canvas.getBoundingClientRect();
		return new Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
	}

	/** Where a screen point meets the plane through the core, facing the camera. */
	private planePoint(clientX: number, clientY: number): Vector3 | null {
		this.raycaster.setFromCamera(this.ndc(clientX, clientY), this.camera);
		const normal = this.camera.getWorldDirection(new Vector3()).negate();
		const plane = new Plane().setFromNormalAndCoplanarPoint(normal, new Vector3(0, 0, 0));
		return this.raycaster.ray.intersectPlane(plane, new Vector3());
	}

	private pick(clientX: number, clientY: number): { type: "orb" | "seed" | "satellite" | "core" | "vibr"; key: string } | null {
		this.raycaster.setFromCamera(this.ndc(clientX, clientY), this.camera);
		if (this.sceneState?.mode === "constellation") {
			const targets: Object3D[] = [...[...this.orbs.values()].map(orb => orb.core.hit)];
			if (this.seed) targets.push(this.seed.hit);
			const hit = this.raycaster.intersectObjects(targets, false)[0];
			if (!hit) return null;
			if (this.seed && hit.object === this.seed.hit) return { type: "seed", key: NEW_AGENT_KEY };
			for (const [key, orb] of this.orbs) if (orb.core.hit === hit.object) return { type: "orb", key };
			return null;
		}
		if (this.vibrWheel) {
			const hit = this.raycaster.intersectObjects(this.vibrWheel.options.map(option => option.core.hit), false)[0];
			if (hit) {
				const option = this.vibrWheel.options.find(o => o.core.hit === hit.object);
				if (option) return { type: "vibr", key: option.vibr };
			}
			return null;
		}
		const bodies = [...this.satellites.entries()].filter(([, node]) => !node.leaving);
		// Satellites are small; test with an inflated radius in screen space.
		const screen = this.ndc(clientX, clientY);
		let best: { key: string; distance: number } | null = null;
		const world = new Vector3();
		for (const [key, node] of bodies) {
			node.mesh.getWorldPosition(world);
			const projected = world.project(this.camera);
			const dx = (projected.x - screen.x) * this.width * 0.5;
			const dy = (projected.y - screen.y) * this.height * 0.5;
			const distance = Math.hypot(dx, dy);
			if (distance < 16 && (best === null || distance < best.distance)) best = { key, distance };
		}
		if (best) return { type: "satellite", key: best.key };
		if (this.core && this.raycaster.intersectObject(this.core.hit, false).length > 0) return { type: "core", key: "core" };
		return null;
	}

	private readonly onPointerMove = (event: PointerEvent) => {
		const ndc = this.ndc(event.clientX, event.clientY);
		this.pointer.set(ndc.x, ndc.y);
		const gesture = this.gesture;
		if (gesture?.kind === "thinking") {
			const steps = Math.trunc((gesture.startY - event.clientY) / 28);
			while (steps > gesture.steps) {
				gesture.steps++;
				this.events.thinkingStep(1);
			}
			while (steps < gesture.steps) {
				gesture.steps--;
				this.events.thinkingStep(-1);
			}
			return;
		}
		if (gesture?.kind === "satellite") {
			const node = this.satellites.get(gesture.key);
			const moved = Math.hypot(event.clientX - gesture.startX, event.clientY - gesture.startY);
			if (moved > 6) gesture.moved = true;
			if (node) node.label.classList.toggle("is-releasing", moved > 90);
			this.canvas.style.cursor = moved > 90 ? "not-allowed" : "grabbing";
			return;
		}
		const hit = this.pick(event.clientX, event.clientY);
		const hoverKey = hit?.type === "orb" || hit?.type === "seed" ? hit.key : null;
		this.hoverKey = hoverKey;
		if (hit?.type === "vibr") this.events.previewVibr(hit.key as Vibr);
		for (const [key, node] of this.satellites) node.label.classList.toggle("is-hovered", hit?.type === "satellite" && hit.key === key);
		this.canvas.style.cursor = hit === null ? "default" : hit.type === "core" ? "ns-resize" : hit.type === "satellite" ? "grab" : "pointer";
	};

	private readonly onPointerDown = (event: PointerEvent) => {
		if (event.button !== 0) return;
		const hit = this.pick(event.clientX, event.clientY);
		if (hit?.type === "core") {
			this.gesture = { kind: "thinking", startY: event.clientY, steps: 0 };
			this.canvas.setPointerCapture(event.pointerId);
			return;
		}
		if (hit?.type === "satellite") {
			this.gesture = { kind: "satellite", key: hit.key, startX: event.clientX, startY: event.clientY, moved: false };
			this.canvas.setPointerCapture(event.pointerId);
			return;
		}
		this.gesture = { kind: "press", startX: event.clientX, startY: event.clientY };
	};

	private readonly onPointerUp = (event: PointerEvent) => {
		const gesture = this.gesture;
		this.gesture = null;
		if (this.canvas.hasPointerCapture(event.pointerId)) this.canvas.releasePointerCapture(event.pointerId);
		if (gesture?.kind === "thinking") return;
		if (gesture?.kind === "satellite") {
			const node = this.satellites.get(gesture.key);
			node?.label.classList.remove("is-releasing");
			if (!node) return;
			const moved = Math.hypot(event.clientX - gesture.startX, event.clientY - gesture.startY);
			if (moved > 90) this.events.releaseSatellite(node.satellite);
			else if (!gesture.moved) this.events.selectSatellite(this.selectedKey === gesture.key ? null : node.satellite);
			return;
		}
		if (gesture?.kind !== "press" || Math.hypot(event.clientX - gesture.startX, event.clientY - gesture.startY) > 6) return;
		const hit = this.pick(event.clientX, event.clientY);
		if (hit?.type === "orb" || hit?.type === "seed") this.events.pickAgent(hit.key);
		else if (hit?.type === "vibr") this.events.pickVibr(hit.key as Vibr);
		else if (this.sceneState?.mode === "forge") {
			if (this.vibrWheel) this.events.previewVibr(null);
			this.events.selectSatellite(null);
		}
	};

	private readonly onPointerLeave = () => {
		this.pointer.set(0, 0);
		this.hoverKey = null;
		if (this.vibrWheel) this.events.previewVibr(null);
	};

	private readonly onDoubleClick = (event: MouseEvent) => {
		if (this.sceneState?.mode !== "forge" || this.vibrWheel) return;
		if (this.pick(event.clientX, event.clientY)?.type === "core") this.events.openVibr();
	};

	private readonly onVisibility = () => {
		// Drop the paused interval so a returning tab does not lurch.
		if (document.visibilityState === "visible") this.clock.getDelta();
	};
}

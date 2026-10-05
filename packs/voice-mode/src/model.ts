// What the Voice pane says, as pure functions over the two public root facts it reads
// (`speech/profiles`, `agents/list`). No React, no host: the pane is a view of what this returns.
//
// The facts come from an engine this bundle was not built with, so every reader here is DEFENSIVE:
// a row that is not the shape the pane expects is dropped, never thrown on, and an absent fact is the
// honest "no speech engine" state. A throwing pane would only be caught by the Settings crash boundary
// and cost the user the whole pane.

export type VoiceLayer = "workspace" | "user" | "pack" | "builtin";

export interface Readiness {
	readonly ready: boolean;
	readonly reason?: string;
	readonly detail?: string;
}

export interface SpeakStep {
	readonly provider: string;
	readonly model: string;
	readonly voice?: string;
}

/** One live choice of a profile (doc 92): a realtime provider, optionally its model and voice. */
export interface LiveStep {
	readonly provider: string;
	readonly model?: string;
	readonly voice?: string;
}

export interface ProfileRow {
	readonly name: string;
	readonly layer: VoiceLayer;
	readonly description?: string;
	readonly speak: readonly SpeakStep[];
	/** The live voices the profile names, in fallback order; empty = the profile offers no live call. */
	readonly converse: readonly LiveStep[];
}

export interface ProviderRow {
	readonly id: string;
	readonly label: string;
	readonly speak?: Readiness;
	readonly listen?: Readiness;
	/** Present exactly when the provider talks live. */
	readonly converse?: Readiness;
}

export interface DefaultProfile {
	readonly name: string;
	readonly why: string;
}

/** Where the `classifier` role resolves, as `speech/profiles.classifier` says it (ids, not display names). */
export interface ClassifierRoute {
	readonly provider: string;
	readonly model: string;
	/** The classifier's endpoint is not loopback: what it reads is sent off this device. */
	readonly leavesDevice: boolean;
	/** The endpoint's hostname, named only when `leavesDevice`. */
	readonly host?: string;
}

export interface ProfilesView {
	readonly profiles: readonly ProfileRow[];
	readonly providers: readonly ProviderRow[];
	readonly default: DefaultProfile | null;
	/** Absent = the engine does not say (an older engine): the pane makes no claim. `null` = no classifier role resolves. */
	readonly classifier?: ClassifierRoute | null;
}

/** The on-device provider's id: the built-in `local` profile names it, and a profile with no reachable
 *  entry falls back to it (doc 90 §5, "`local` is always last"). */
export const LOCAL_PROVIDER = "local";

const LAYERS: Readonly<Record<string, true>> = { workspace: true, user: true, pack: true, builtin: true };

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

const text = (value: unknown): string | undefined => (typeof value === "string" && value !== "" ? value : undefined);

function readReadiness(value: unknown): Readiness | undefined {
	if (!isRecord(value) || typeof value.ready !== "boolean") return undefined;
	const reason = text(value.reason);
	const detail = text(value.detail);
	return { ready: value.ready, ...(reason ? { reason } : {}), ...(detail ? { detail } : {}) };
}

function readStep(value: unknown): SpeakStep | undefined {
	if (!isRecord(value)) return undefined;
	const provider = text(value.provider);
	const model = text(value.model);
	if (!provider || !model) return undefined;
	const voice = text(value.voice);
	return { provider, model, ...(voice ? { voice } : {}) };
}

function readLiveStep(value: unknown): LiveStep | undefined {
	if (!isRecord(value)) return undefined;
	const provider = text(value.provider);
	if (!provider) return undefined;
	const model = text(value.model);
	const voice = text(value.voice);
	return { provider, ...(model ? { model } : {}), ...(voice ? { voice } : {}) };
}

function readProfile(value: unknown): ProfileRow | undefined {
	if (!isRecord(value)) return undefined;
	const name = text(value.name);
	if (!name || typeof value.layer !== "string" || !Object.hasOwn(LAYERS, value.layer)) return undefined;
	const description = text(value.description);
	const speak = Array.isArray(value.speak) ? value.speak.flatMap(step => readStep(step) ?? []) : [];
	const converse = Array.isArray(value.converse) ? value.converse.flatMap(step => readLiveStep(step) ?? []) : [];
	return { name, layer: value.layer as VoiceLayer, speak, converse, ...(description ? { description } : {}) };
}

function readProvider(value: unknown): ProviderRow | undefined {
	if (!isRecord(value)) return undefined;
	const id = text(value.id);
	if (!id) return undefined;
	const speak = readReadiness(value.speak);
	const listen = readReadiness(value.listen);
	const converse = readReadiness(value.converse);
	return {
		id,
		label: text(value.label) ?? id,
		...(speak ? { speak } : {}),
		...(listen ? { listen } : {}),
		...(converse ? { converse } : {}),
	};
}

/** `undefined`: the engine does not say, or said something this pane cannot read (no claim either way, never a throw).
 *  `null`: it said no classifier role resolves. */
function readClassifier(value: unknown): ClassifierRoute | null | undefined {
	if (value === null) return null;
	if (!isRecord(value)) return undefined;
	const provider = text(value.provider);
	const model = text(value.model);
	if (!provider || !model || typeof value.leavesDevice !== "boolean") return undefined;
	const host = value.leavesDevice ? text(value.host) : undefined;
	return { provider, model, leavesDevice: value.leavesDevice, ...(host ? { host } : {}) };
}

/** The `speech/profiles` fact as the pane uses it; null when the engine published none (no speech runtime). */
export function readProfilesFact(raw: unknown): ProfilesView | null {
	if (!isRecord(raw)) return null;
	const profiles = Array.isArray(raw.profiles) ? raw.profiles.flatMap(row => readProfile(row) ?? []) : [];
	const providers = Array.isArray(raw.providers) ? raw.providers.flatMap(row => readProvider(row) ?? []) : [];
	const fallback = isRecord(raw.default) ? text(raw.default.name) : undefined;
	const classifier = readClassifier(raw.classifier);
	return {
		profiles,
		providers,
		default: fallback ? { name: fallback, why: (isRecord(raw.default) && text(raw.default.why)) || "" } : null,
		...(classifier !== undefined ? { classifier } : {}),
	};
}

export type Tone = "ok" | "warn" | "off";

export interface StateLine {
	readonly tone: Tone;
	readonly text: string;
}

const REASONS: Readonly<Record<string, string>> = {
	"needs-key": "Needs an API key",
	"needs-download": "Needs a download",
	unavailable: "Unavailable",
};

/** What a provider can do: speak a reply, listen, or hold a live call. */
type Lane = "speak" | "listen" | "live";

const ABSENT: Readonly<Record<Lane, string>> = {
	speak: "Does not speak",
	listen: "Does not listen",
	live: "Does not talk live",
};

/** One readiness as a sentence a person can act on. `undefined` = the provider does not do this at all. */
function stateLine(readiness: Readiness | undefined, verb: Lane): StateLine {
	if (!readiness) return { tone: "off", text: ABSENT[verb] };
	if (readiness.ready) return { tone: "ok", text: "Ready" };
	const reason = readiness.reason;
	return { tone: "warn", text: reason !== undefined && Object.hasOwn(REASONS, reason) ? (REASONS[reason] as string) : "Not ready" };
}

export interface ChainStep {
	readonly providerLabel: string;
	readonly model: string;
	readonly voice?: string;
	readonly state: StateLine;
	readonly detail?: string;
	readonly ready: boolean;
}

export interface LiveStepView {
	readonly providerLabel: string;
	readonly voice?: string;
	readonly state: StateLine;
	readonly detail?: string;
	readonly ready: boolean;
}

export interface ProfileView {
	readonly name: string;
	readonly layer: VoiceLayer;
	readonly layerLabel: string;
	readonly description?: string;
	readonly isDefault: boolean;
	readonly steps: readonly ChainStep[];
	/** The entry that will actually speak: the first ready one, or the on-device voice when none is. `fellBack`: it is not
	 *  the profile's first choice, and `because` names that first choice, which is not ready. */
	readonly speaksWith: { readonly label: string; readonly fellBack: boolean; readonly because?: string } | null;
	/** The profile's live choices, in fallback order, each with what it would do right now; empty = the profile offers no live call. */
	readonly live: readonly LiveStepView[];
	/** The live voice a call would open: the first ready choice (there is no on-device fallback for a live call). */
	readonly liveWith: { readonly label: string; readonly fellBack: boolean; readonly because?: string } | null;
}

export const LAYER_LABELS: Readonly<Record<VoiceLayer, string>> = {
	workspace: "This workspace",
	user: "Yours",
	pack: "From a plugin",
	builtin: "Built in",
};

function stepOf(step: SpeakStep, providers: ReadonlyMap<string, ProviderRow>): ChainStep {
	const provider = providers.get(step.provider);
	// A profile can name a provider that is not installed (a pack that is off): it cannot speak, and
	// the pane says so rather than guessing at a label.
	const state: StateLine = provider ? stateLine(provider.speak, "speak") : { tone: "warn", text: "Not installed" };
	const detail = provider?.speak && !provider.speak.ready ? provider.speak.detail : undefined;
	return {
		providerLabel: provider?.label ?? step.provider,
		model: step.model,
		...(step.voice ? { voice: step.voice } : {}),
		state,
		...(detail ? { detail } : {}),
		ready: state.tone === "ok",
	};
}

function liveStepOf(step: LiveStep, providers: ReadonlyMap<string, ProviderRow>): LiveStepView {
	const provider = providers.get(step.provider);
	// Same honesty as speaking: a profile can name a provider that is not installed, and an installed one may not talk live at all.
	const state: StateLine = provider ? stateLine(provider.converse, "live") : { tone: "warn", text: "Not installed" };
	const detail = provider?.converse && !provider.converse.ready ? provider.converse.detail : undefined;
	return {
		providerLabel: provider?.label ?? step.provider,
		...(step.voice ? { voice: step.voice } : {}),
		state,
		...(detail ? { detail } : {}),
		ready: state.tone === "ok",
	};
}

/**
 * What a chain of choices would do right now: its first ready step. `fellBack`: it is not the first choice, and `because`
 * names that first choice, which is not ready. With no ready step it is `lastResort` when there is one (speaking has the
 * on-device voice; a live call has none), else null.
 */
function choiceOf(steps: readonly Pick<ChainStep, "ready" | "providerLabel">[], lastResort?: string): ProfileView["speaksWith"] {
	const firstReady = steps.findIndex(step => step.ready);
	const head = steps[0];
	const because = head && firstReady !== 0 ? head.providerLabel : undefined;
	const passedOver = because ? { because } : {};
	const chosen = steps[firstReady];
	if (chosen) return { label: chosen.providerLabel, fellBack: firstReady > 0, ...passedOver };
	return lastResort === undefined ? null : { label: lastResort, fellBack: true, ...passedOver };
}

export function profileViews(view: ProfilesView): ProfileView[] {
	const providers = new Map(view.providers.map(provider => [provider.id, provider]));
	const local = providers.get(LOCAL_PROVIDER);
	const onDevice = local?.speak?.ready === true ? (local?.label ?? "On-device voice") : undefined;
	return view.profiles.map(profile => {
		const steps = profile.speak.map(step => stepOf(step, providers));
		const live = profile.converse.map(step => liveStepOf(step, providers));
		return {
			name: profile.name,
			layer: profile.layer,
			layerLabel: LAYER_LABELS[profile.layer],
			...(profile.description ? { description: profile.description } : {}),
			isDefault: view.default?.name === profile.name,
			steps,
			speaksWith: choiceOf(steps, onDevice),
			live,
			liveWith: choiceOf(live),
		};
	});
}

export interface Headline {
	readonly tone: Tone;
	readonly text: string;
}

/** The one line at the top: can voice mode speak right now, and in whose voice by default. */
export function headline(view: ProfilesView | null): Headline {
	if (!view) return { tone: "off", text: "This engine has no speech runtime, so voice mode is not available here." };
	const profiles = profileViews(view);
	const chosen = profiles.find(profile => profile.isDefault);
	if (!chosen) return { tone: "warn", text: "No default voice is set." };
	if (!chosen.speaksWith) {
		return { tone: "warn", text: `The default voice, ${chosen.name}, has nothing ready to speak with.` };
	}
	return {
		tone: "ok",
		text: chosen.speaksWith.fellBack
			? `The default voice, ${chosen.name}, speaks with ${chosen.speaksWith.label}${chosen.speaksWith.because ? `: ${chosen.speaksWith.because} is not ready` : ""}.`
			: `The default voice, ${chosen.name}, speaks with ${chosen.speaksWith.label}.`,
	};
}

/** Whether anything on this engine talks live: a provider that does, or a voice that names a live choice. */
function offersLive(view: ProfilesView): boolean {
	return view.providers.some(provider => provider.converse !== undefined) || view.profiles.some(profile => profile.converse.length > 0);
}

/**
 * The line under the headline about Talk live: which live voice the default voice would open. Null when nothing on this
 * engine talks live (an older engine, or no live pack installed): the pane says nothing rather than something about a
 * feature that is not there.
 */
export function liveHeadline(view: ProfilesView | null): Headline | null {
	if (!view) return null;
	if (!offersLive(view)) return null;
	const chosen = profileViews(view).find(profile => profile.isDefault);
	if (!chosen) return null;
	if (chosen.live.length === 0) {
		return { tone: "off", text: `Talk live is not set up for the default voice, ${chosen.name}: it names no live voice.` };
	}
	if (!chosen.liveWith) return { tone: "warn", text: `Talk live has nothing ready for the default voice, ${chosen.name}.` };
	return {
		tone: "ok",
		text: chosen.liveWith.fellBack
			? `Talk live uses ${chosen.liveWith.label} for the default voice, ${chosen.name}${chosen.liveWith.because ? `: ${chosen.liveWith.because} is not ready` : ""}.`
			: `Talk live uses ${chosen.liveWith.label} for the default voice, ${chosen.name}.`,
	};
}

/**
 * Where a Talk live call's microphone audio goes, as a plain sentence the pane SHOWS: a realtime voice is the provider's own
 * service, so the audio leaves this machine for as long as a call is open. It names the provider the default voice would open
 * (else says it is the live voice's provider), the same standard as the classifier's disclosure. Null when the pane says
 * nothing about Live.
 */
export function liveDisclosure(view: ProfilesView | null): string | null {
	if (!view || !offersLive(view)) return null;
	const label = profileViews(view).find(profile => profile.isDefault)?.liveWith?.label;
	return `Talking live sends your microphone audio off this machine to ${label ?? "the live voice's provider"} for as long as a call is open.`;
}

export interface EngineView {
	/** The right-hand state: what the engine does first (speaks, else talks live). */
	readonly primary: { readonly tone: Tone; readonly text: string; readonly title?: string };
	/** The line under its name. */
	readonly meta: string;
}

/** `Listening: Needs a download (4 GB)`: the state, and the engine's own words when it is not ready. */
function said(label: string, verb: Lane, readiness: Readiness): string {
	const detail = readiness.detail && !readiness.ready ? ` (${readiness.detail})` : "";
	return `${label}: ${stateLine(readiness, verb).text}${detail}`;
}

/** The right-hand line of a lane the engine has: its state, and the engine's own words as the tooltip. */
function laneOf(label: string, verb: Lane, readiness: Readiness): EngineView["primary"] {
	const state = stateLine(readiness, verb);
	return { tone: state.tone, text: `${label}: ${state.text}`, ...(readiness.detail ? { title: readiness.detail } : {}) };
}

/** The right-hand state: what the engine does first (speaks, else talks live). */
function primaryOf(provider: ProviderRow): EngineView["primary"] {
	if (provider.speak) return laneOf("Speaking", "speak", provider.speak);
	if (provider.converse) return laneOf("Live", "live", provider.converse);
	// A provider that only listens still says plainly that it does not speak.
	return stateLine(undefined, "speak");
}

/** The line under the engine's name. */
function metaOf(provider: ProviderRow): string {
	const bits: string[] = [];
	if (provider.listen) bits.push(said("Listening", "listen", provider.listen));
	// Live is the whole story of a provider that does nothing else; beside speaking it is a second fact.
	if (provider.converse && provider.speak) bits.push(said("Live", "live", provider.converse));
	if (bits.length > 0) return bits.join(" · ");
	return provider.converse ? "Talks live only" : "Speaks only";
}

/** One speech engine as the pane's list draws it. A provider that only talks live says so instead of "Does not speak". */
export function engineView(provider: ProviderRow): EngineView {
	return { primary: primaryOf(provider), meta: metaOf(provider) };
}

export interface AgentRow {
	readonly name: string;
	readonly title: string;
	/** The voice profile the agent's own manifest names; a user or workspace assignment can still outrank it. */
	readonly voice: string | null;
}

/** The enabled General Agents of `agents/list`, by display name. */
export function readAgents(raw: unknown): AgentRow[] {
	if (!Array.isArray(raw)) return [];
	const seen = new Set<string>();
	const rows: AgentRow[] = [];
	for (const value of raw) {
		if (!isRecord(value)) continue;
		const name = text(value.name);
		if (!name || seen.has(name) || value.enabled === false) continue;
		seen.add(name);
		rows.push({ name, title: text(value.title) ?? name, voice: text(value.voice) ?? null });
	}
	return rows.sort((a, b) => a.title.localeCompare(b.title));
}

export interface ModelsView {
	/** Connected chat models: what the `voice` role (then `tiny`, then `smol`) can resolve to. */
	readonly chat: number;
	/** Connected classify-only models (TypeSafe's Jev, a local System One): what the `classifier` role can hold. */
	readonly classifiers: readonly string[];
}

/** The public `models` catalog reduced to the two counts the Voice pane's model rows need. Null when absent. */
export function readModelsFact(raw: unknown): ModelsView | null {
	if (!Array.isArray(raw)) return null;
	let chat = 0;
	const classifiers: string[] = [];
	for (const value of raw) {
		if (!isRecord(value) || value.available !== true) continue;
		if (value.kind === "classify") {
			const label = text(value.label) ?? text(value.modelId);
			if (label && !classifiers.includes(label)) classifiers.push(label);
		} else {
			chat += 1;
		}
	}
	return { chat, classifiers };
}

export interface ModelRow {
	/** The model role's id, as `models` and the config name it. */
	readonly role: "voice" | "classifier";
	readonly title: string;
	readonly tone: Tone;
	readonly says: string;
	readonly hint: string;
	/** The hint states where the classifier's input goes: render it as plain text, not as small print. */
	readonly disclosure?: true;
}

const CLASSIFIER_HINT = "The classifier is the judge model (Jev by default). It only decides whether a message is worth saying; voice mode works without it.";

/** The Classifier row once the engine says where the role resolves. What the classifier reads leaves this device when its
 *  endpoint is remote, so the row says what, to whom and when, in a sentence the user can act on. */
function classifierRow(route: ClassifierRoute | null): ModelRow {
	if (!route) {
		return { role: "classifier", title: "Classifier", tone: "off", says: "No classifier is connected: a plain rule decides, and nothing is sent.", hint: CLASSIFIER_HINT };
	}
	const name = `${route.provider}/${route.model}`;
	const hint = route.leavesDevice
		? `While voice mode is on, the classifier (${name}) is asked two things. To read your mood, on each message, your last six messages to the agent (scrubbed of code, paths and secrets) and the agent's last spoken line go to ${route.host ?? route.provider}. To judge what is worth saying, for each line the voice is about to say, the part of the agent's reply it comes from (scrubbed, up to 700 characters) and your last request go there too. With voice mode off, nothing is sent.`
		: `While voice mode is on, the classifier (${name}) runs on this device; nothing leaves it.`;
	return { role: "classifier", title: "Classifier", tone: "ok", says: `${name} reads your mood and judges what is worth saying.`, hint, disclosure: true };
}

/** The two model roles voice mode uses, said in plain words. The voice role's resolution is not on the public Store, so
 *  its row states what is CONNECTED and how the role falls back, never a model it cannot know. The classifier's does
 *  arrive, on `speech/profiles.classifier` from newer engines: pass it as `route` to state where the role resolves
 *  (`null` = none does); `undefined` (an older engine) keeps the connected-models row and makes no claim. */
export function modelRows(models: ModelsView | null, route?: ClassifierRoute | null): ModelRow[] {
	const voiceHint = "Set the voice model in Models to pick the small model that writes what is spoken. Unset, it falls back to your tiny model, then your small one.";
	const voice: ModelRow = !models
		? { role: "voice", title: "Voice model", tone: "off", says: "Not known yet.", hint: voiceHint }
		: models.chat > 0
			? { role: "voice", title: "Voice model", tone: "ok", says: `${models.chat} chat ${models.chat === 1 ? "model is" : "models are"} connected to write spoken replies.`, hint: voiceHint }
			: { role: "voice", title: "Voice model", tone: "warn", says: "No chat model is connected, so replies use a bounded, cleaned spoken fallback.", hint: voiceHint };
	const classifier: ModelRow = route !== undefined
		? classifierRow(route)
		: !models
			? { role: "classifier", title: "Classifier", tone: "off", says: "Not known yet.", hint: CLASSIFIER_HINT }
			: models.classifiers.length > 0
				? { role: "classifier", title: "Classifier", tone: "ok", says: `${models.classifiers.join(", ")} can judge what is worth saying.`, hint: CLASSIFIER_HINT }
				: { role: "classifier", title: "Classifier", tone: "off", says: "None connected: a plain rule decides what is worth saying.", hint: CLASSIFIER_HINT };
	return [voice, classifier];
}

export interface TuningKey {
	readonly key: string;
	readonly fallback: string;
	readonly what: string;
}

/** The `voice` block keys of the product config (`~/.inso/config.json`, or the workspace's `.inso/config.json`). The
 *  engine reads them; nothing in the Store carries their values, so the pane lists them and does not pretend to show them. */
export const TUNING_KEYS: readonly TuningKey[] = [
	{ key: "vocalizer.mode", fallback: "conversational", what: "Conversational scales the spoken result to what matters; Brief keeps it to one or two lines. Neither reads the whole summary." },
	{ key: "vocalizer.enhanced", fallback: "on when a voice model is connected", what: "Rewrite replies into spoken prose with the small model." },
	{ key: "attention.catchUpAfterMinutes", fallback: "60", what: "How long away from an agent before it welcomes you back." },
	{ key: "attention.chimes", fallback: "on", what: "A soft tone when a message is waiting." },
	{ key: "live.idleMinutes", fallback: "5", what: "A live call hangs up by itself after this many minutes with nothing said. 0 keeps it open until you end it." },
];

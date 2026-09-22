// The View proper: open a profile, watch it, request things, approve things,
// crop things. Every capability comes from one opaque `browserId` that arrives
// in this View's own `browser_open` tool result — there is no listing, and the
// id is held in React state only (never storage, never a URL).
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { App } from "@modelcontextprotocol/ext-apps";
import type { BrowserAction, BrowserEngine, BrowserState } from "../../src/contracts";
import { BROWSER_ENGINES } from "../../src/contracts";
import { ActionQueue } from "./action-queue";
import { AnnotatePanel } from "./annotate-panel";
import { BrowserClient, BrowserToolError, describeAction, REDACTED_TEXT } from "./browser-client";
import { Controls } from "./controls";
import { Badge, Button, Field, Input, Select, Separator, Spinner } from "@fraym/ui/elements"
import { useBrowserPoll } from "./use-browser-poll";
import { type CanvasTool, type SketchState, ViewportCanvas } from "./viewport-canvas";

const TOOLS: readonly { value: CanvasTool; label: string }[] = [
	{ value: "interact", label: "Interact" },
	{ value: "region", label: "Region" },
	{ value: "circle", label: "Circle" },
	{ value: "freehand", label: "Freehand" },
];

/** The runtime's reserved slug for attached Chrome; other engines refuse it. */
const RELAY_PROFILE = "relay";

interface Step {
	readonly id: number;
	readonly at: string;
	readonly text: string;
	readonly tone: "accent" | "add" | "warn" | "del" | "mute";
}

export interface BrowserAppProps {
	readonly app: App;
	/** The state carried by the tool result that mounted (or re-targeted) this
	 *  View — the only place a browserId may come from. */
	readonly toolState: { state: BrowserState; seq: number } | null;
}

function failureText(cause: unknown): string {
	return cause instanceof BrowserToolError ? `${cause.tool}: ${cause.message}` : cause instanceof Error ? cause.message : String(cause);
}

export function BrowserApp({ app, toolState }: BrowserAppProps) {
	const client = useMemo(() => new BrowserClient(app), [app]);

	const [browserId, setBrowserId] = useState<string | null>(null);
	const [opened, setOpened] = useState<BrowserState | null>(null);
	const [profiles, setProfiles] = useState<readonly string[] | null>(null);
	const [profilesError, setProfilesError] = useState<string | null>(null);
	const [profile, setProfile] = useState("default");
	const [engine, setEngine] = useState<BrowserEngine>("chromium");
	const [openUrl, setOpenUrl] = useState("");
	const [opening, setOpening] = useState(false);
	const [openError, setOpenError] = useState<string | null>(null);
	const [tool, setTool] = useState<CanvasTool>("interact");
	const [sketch, setSketch] = useState<SketchState>({ region: null, marks: [] });
	const [clearToken, setClearToken] = useState(0);
	const [busy, setBusy] = useState(false);
	const [resolving, setResolving] = useState<string | null>(null);
	const [snapshot, setSnapshot] = useState<{ browserId: string; text: string } | null>(null);
	const [steps, setSteps] = useState<readonly Step[]>([]);
	const [actionError, setActionError] = useState<string | null>(null);

	// The browser the UI is bound to; awaited results for anything else are dropped.
	const boundRef = useRef<string | null>(null);
	boundRef.current = browserId;
	// False once this View is torn down: no awaited callback may set state after.
	const mountedRef = useRef(true);
	useEffect(() => {
		mountedRef.current = true;
		return () => {
			mountedRef.current = false;
		};
	}, []);
	// The browser whose arrival has already been written to History, so a
	// re-delivered tool result for the SAME browser never logs a second "opened".
	const loggedOpenRef = useRef<string | null>(null);
	// One request id per distinct intent, reused on retry so a re-press can never
	// become a second claim for the same thing.
	const requestIds = useRef(new Map<string, string>());

	const annotating = tool !== "interact";
	const poll = useBrowserPoll(client, browserId, annotating);
	const state = poll.state ?? opened;
	// chrome-relay has exactly one identity — the signed-in Chrome it attaches to.
	const relay = engine === "chrome-relay";

	const log = useCallback((text: string, tone: Step["tone"]) => {
		setSteps(current =>
			[{ id: Date.now() + current.length, at: new Date().toLocaleTimeString(), text, tone }, ...current].slice(0, 60),
		);
	}, []);

	// A tool result is the ONLY source of a browserId, and it is folded in DURING
	// RENDER (React's "adjust state when a prop changes" pattern) rather than in
	// an effect: a View mounted by `browser_open` must paint the live browser on
	// its first frame, not flash the open form and then replace it.
	//
	// The host's `ui/notifications/tool-result` carries no tool name, so a
	// `browser_state` or `browser_snapshot` result for the browser already on
	// screen arrives here looking exactly like a re-target. Only a CHANGE of
	// browserId is one: everything destructive (the retry map, the sketch, the
	// armed drawing tool, the form fields) is gated on that, so a model turn
	// cannot wipe a half-drawn crop out from under the human.
	const [seenSeq, setSeenSeq] = useState(0);
	if (toolState !== null && toolState.seq !== seenSeq) {
		setSeenSeq(toolState.seq);
		setOpened(toolState.state);
		setOpenError(null);
		if (toolState.state.browserId !== browserId) {
			setBrowserId(toolState.state.browserId);
			setProfile(toolState.state.profile);
			setEngine(toolState.state.engine);
			setSnapshot(null);
			requestIds.current.clear();
			setClearToken(token => token + 1);
			setTool("interact");
		}
	}
	// The history line for that arrival is a side effect, so it stays in one —
	// and it is written once per browser, not once per notification.
	useEffect(() => {
		if (toolState === null) return;
		const arrived = toolState.state;
		if (loggedOpenRef.current === arrived.browserId) return;
		loggedOpenRef.current = arrived.browserId;
		log(`opened ${arrived.profile} (${arrived.engine})`, "accent");
	}, [toolState, log]);

	useEffect(() => {
		let current = true;
		void client.bindBrowser(browserId).catch(cause => {
			if (current) log(`conversation binding failed — ${failureText(cause)}`, "del");
		});
		return () => { current = false; };
	}, [client, browserId, log]);

	// The profile list is app-only: it names profiles, never live browsers.
	useEffect(() => {
		let alive = true;
		client.profiles().then(
			list => {
				if (!alive) return;
				const managed = list.filter(name => name !== RELAY_PROFILE);
				setProfiles(managed);
				setProfilesError(null);
				setProfile(current => (current === "default" ? (managed[0] ?? "default") : current));
			},
			cause => {
				if (!alive) return;
				setProfiles([]);
				setProfilesError(failureText(cause));
			},
		);
		return () => {
			alive = false;
		};
	}, [client]);

	// An awaited result may land after this View was torn down, or after a tool
	// result re-targeted it at another browser: either way it is dropped rather
	// than painted over the page that is on screen now.
	const live = (bound: string) => mountedRef.current && boundRef.current === bound;

	const open = async () => {
		// chrome-relay attaches to the ONE Chrome identity already signed in; the
		// runtime reserves the literal profile "relay" for it and refuses that slug
		// for other engines, which own isolated persistent profiles.
		const target = engine === "chrome-relay" ? RELAY_PROFILE : profile.trim();
		if (target.length === 0) return;
		setOpening(true);
		setOpenError(null);
		try {
			const next = await client.open({ profile: target, engine, url: openUrl.trim() || undefined });
			// The browser exists whatever happened here meanwhile, so an unmounted
			// View simply stops: it must not paint, and it has nothing to undo.
			if (!mountedRef.current) return;
			setBrowserId(next.browserId);
			setOpened(next);
			if (next.engine !== "chrome-relay") setProfiles(current => [...new Set([...(current ?? []), next.profile])].sort());
			setSnapshot(null);
			requestIds.current.clear();
			setClearToken(token => token + 1);
			setTool("interact");
			const queued = next.actions.filter(action => action.status === "pending").length;
			loggedOpenRef.current = next.browserId;
			log(
				`opened ${next.profile} (${next.engine})${queued > 0 ? ` — ${queued} navigation queued for your approval` : ""}`,
				"accent",
			);
		} catch (cause) {
			if (mountedRef.current) setOpenError(failureText(cause));
		} finally {
			if (mountedRef.current) setOpening(false);
		}
	};

	const refreshState = async (bound: string) => {
		try {
			const next = await client.state(bound);
			if (live(bound)) poll.push(next);
		} catch {
			// The poll loop owns error reporting for state reads.
		}
	};

	/** Queues one action. Resolves true only when the runtime accepted it, so a
	 *  control can keep the human's draft when it did not. */
	const request = async (action: BrowserAction): Promise<boolean> => {
		const bound = browserId;
		if (bound === null) return false;
		// Retain only a fingerprint for retries, never typed credentials. Equal
		// length text is NOT the same intent.
		const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(action)));
		if (!live(bound)) return false;
		const intent = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
		let requestId = requestIds.current.get(intent);
		if (requestId === undefined) {
			requestId = `view-${crypto.randomUUID()}`;
			requestIds.current.set(intent, requestId);
		}
		// The History never holds a typed value, not even its length: a refusal
		// happens before the runtime ever made its redacted copy, so this View
		// makes one itself before it writes the line.
		const logged = action.kind === "type" ? { ...action, text: REDACTED_TEXT } : action;
		setBusy(true);
		setActionError(null);
		try {
			const pending = await client.requestAction(bound, requestId, action);
			if (!live(bound)) return false;
			requestIds.current.delete(intent);
			// The QUEUE's copy, not the local one: History and the approval line
			// must describe the same thing, and the local action still holds the
			// typed value the runtime redacts.
			log(`requested: ${describeAction(pending.action)} → ${pending.status}`, pending.status === "pending" ? "warn" : "accent");
			await refreshState(bound);
			return true;
		} catch (cause) {
			if (!live(bound)) return false;
			const detail = failureText(cause);
			setActionError(detail);
			log(`request refused: ${describeAction(logged)} — ${detail}`, "del");
			return false;
		} finally {
			if (mountedRef.current) setBusy(false);
		}
	};

	/** The exact executable payload behind a pending action, for the human to
	 *  read before approving. It is returned to the queue component and nowhere
	 *  else: it never reaches the History, the model context or the runtime. */
	const previewAction = async (actionId: string): Promise<BrowserAction> => {
		const bound = browserId;
		if (bound === null) throw new BrowserToolError("browser_action_preview", "no browser is bound to this View");
		const action = await client.previewAction(bound, actionId);
		if (!live(bound)) {
			throw new BrowserToolError("browser_action_preview", "the browser changed before the payload arrived; nothing is shown");
		}
		return action;
	};

	const resolve = async (actionId: string, approve: boolean) => {
		const bound = browserId;
		if (bound === null) return;
		setResolving(actionId);
		setActionError(null);
		try {
			// The approval names the immutable action id only — never a payload
			// this View read back, so what is approved is what was queued.
			const pending = await client.resolveAction(bound, actionId, approve);
			if (!live(bound)) return;
			log(`${approve ? "approved" : "denied"}: ${describeAction(pending.action)} → ${pending.status}`, approve ? "add" : "mute");
			await refreshState(bound);
		} catch (cause) {
			if (!live(bound)) return;
			const detail = failureText(cause);
			setActionError(detail);
			log(`${approve ? "approval" : "denial"} failed — ${detail}`, "del");
		} finally {
			if (mountedRef.current) setResolving(null);
		}
	};

	const takeSnapshot = async () => {
		const bound = browserId;
		if (bound === null) return;
		setBusy(true);
		try {
			const result = await client.snapshot(bound);
			if (!live(bound)) return;
			setSnapshot({ browserId: bound, text: result.text });
			poll.push(result.state);
			log(`snapshot taken (${result.text.length} chars)`, "accent");
		} catch (cause) {
			if (!live(bound)) return;
			const detail = failureText(cause);
			setActionError(detail);
			log(`snapshot failed — ${detail}`, "del");
		} finally {
			if (mountedRef.current) setBusy(false);
		}
	};

	const closeBrowser = async () => {
		const bound = browserId;
		if (bound === null) return;
		setBusy(true);
		try {
			await client.close(bound);
			if (!live(bound)) return;
			log("browser closed", "mute");
			setBrowserId(null);
			setOpened(null);
			setSnapshot(null);
			requestIds.current.clear();
			setClearToken(token => token + 1);
			// The drawing tools belong to the browser that is gone: leaving one
			// armed pauses the frame loop of whatever opens next.
			setTool("interact");
		} catch (cause) {
			if (live(bound)) setActionError(failureText(cause));
		} finally {
			if (mountedRef.current) setBusy(false);
		}
	};

	// A crop that reached the host is spent: drop the drawing and let the
	// picture move again.
	const onSketchConsumed = useCallback(() => {
		setClearToken(token => token + 1);
		setTool("interact");
	}, []);

	const onSketchChange = useCallback((next: SketchState) => setSketch(next), []);

	const viewport = state?.viewport ?? { width: 0, height: 0 };
	const shownSnapshot = snapshot !== null && snapshot.browserId === browserId ? snapshot.text : null;

	return (
		<main className="bx-app">
			<header className="bx-head">
				<div className="bx-head-line">
					<h1>Browser</h1>
					{state !== null && (
						<>
							<Badge tone="mute" variant="code">
								{state.profile}
							</Badge>
							<Badge tone="blue" variant="soft">
								{state.engine}
							</Badge>
							<span className="bx-title">{state.title.length > 0 ? state.title : "(untitled)"}</span>
							<span className="bx-url bx-mono">{state.url.length > 0 ? state.url : "about:blank"}</span>
						</>
					)}
				</div>
				{browserId !== null && (
					<div className="bx-head-actions">
						<Button size="sm" variant="outline" disabled={busy} onClick={() => void takeSnapshot()}>
							Snapshot
						</Button>
						<Button size="sm" variant="destructive" disabled={busy} onClick={() => void closeBrowser()}>
							Close browser
						</Button>
					</div>
				)}
			</header>

			{browserId === null ? (
				<section className="bx-open" aria-label="Open a browser">
					<h2>Open a profile</h2>
					{profiles === null ? (
						<p className="bx-empty">
							<Spinner size="sm" label="Loading profiles" /> Loading profiles…
						</p>
					) : (
						<div className="bx-row">
							<Field
								label="Profile"
								helper={
									relay
										? "Uses the identity already signed in to the attached Chrome."
										: profiles.length === 0
											? "No saved profiles — type a name to create one."
											: undefined
								}
								className="bx-grow"
							>
								{relay ? (
									<Input value={RELAY_PROFILE} readOnly disabled aria-label="Profile" />
								) : (
									<>
										<Input value={profile} list="browser-profile-names" placeholder="Choose or create a profile" autoComplete="off" onChange={event => setProfile(event.target.value)} />
										<datalist id="browser-profile-names">
											{profiles.map(name => <option key={name} value={name} />)}
										</datalist>
									</>
								)}
							</Field>
							<Field label="Engine" className="bx-narrow">
								<Select
									value={engine}
									onChange={event => {
										const selected = BROWSER_ENGINES.find(value => value === event.target.value);
										if (selected) setEngine(selected);
									}}
									options={BROWSER_ENGINES.map(value => ({
										value,
										label: value === "abp" ? "abp — unavailable" : value,
										// ABP's control port takes unauthenticated commands from any page
										// it visits, so this pack refuses to start that browser at all.
										disabled: value === "abp",
									}))}
								/>
							</Field>
							<Field label="Open at (optional)" className="bx-grow">
								<Input
									type="url"
									value={openUrl}
									placeholder="https://example.com"
									autoComplete="off"
									spellCheck={false}
									onChange={event => setOpenUrl(event.target.value)}
								/>
							</Field>
							<Button
								loading={opening}
								loadingText="Opening…"
								disabled={!relay && profile.trim().length === 0}
								onClick={() => void open()}
							>
								Open
							</Button>
						</div>
					)}
					{profilesError !== null && (
						<p className="bx-error" role="alert">
							Could not list profiles ({profilesError}). Type a profile name to open one anyway.
						</p>
					)}
					{openError !== null && (
						<p className="bx-error" role="alert">
							{openError}
						</p>
					)}
					<p className="bx-note">
						{relay
							? "chrome-relay attaches to the Chrome you are already signed in to — there are no separate identities to choose. "
							: "A named profile is persistent, isolated, and held by one caller at a time: opening one that is already active is refused rather than shared. "}
						An address given here is queued as a navigation for your approval — the browser starts blank until
						you approve it.
					</p>
				</section>
			) : (
				<div className="bx-body">
					<div className="bx-left">
						<div className="bx-toolbar" role="group" aria-label="Pointer tool">
							{TOOLS.map(entry => (
								<Button
									key={entry.value}
									size="sm"
									variant={tool === entry.value ? "default" : "ghost"}
									aria-pressed={tool === entry.value}
									onClick={() => setTool(entry.value)}
								>
									{entry.label}
								</Button>
							))}
							<Button size="sm" variant="ghost" onClick={() => setClearToken(token => token + 1)}>
								Clear drawing
							</Button>
							<span className="bx-spacer" />
							{poll.loading && <Spinner size="sm" label="Loading frame" />}
							<span className="bx-mono bx-dim">
								{viewport.width}×{viewport.height} px
							</span>
						</div>

						{poll.error !== null && (
							<p className="bx-error" role="alert">
								Frame updates failing — retrying with backoff. {poll.error}
							</p>
						)}

						<ViewportCanvas
							key={browserId}
							frame={poll.frame}
							viewport={viewport}
							tool={tool}
							url={state?.url ?? ""}
							title={state?.title ?? ""}
							frozen={annotating}
							disabled={busy}
							onPoint={point => void request({ kind: "click", x: point.x, y: point.y })}
							onSketchChange={onSketchChange}
							clearToken={clearToken}
						/>

						<Controls url={state?.url ?? ""} disabled={state === null} busy={busy} onRequest={request} />
						{actionError !== null && (
							<p className="bx-error" role="alert">
								{actionError}
							</p>
						)}
					</div>

					<aside className="bx-right">
						<ActionQueue
							key={browserId}
							actions={state?.actions ?? []}
							resolving={resolving}
							disabled={busy}
							onResolve={(actionId, approve) => void resolve(actionId, approve)}
							onPreview={previewAction}
						/>
						<Separator />
						<AnnotatePanel
							key={browserId}
							app={app}
							client={client}
							browserId={browserId}
							frameId={poll.frame?.frameId ?? null}
							region={sketch.region}
							marks={sketch.marks}
							disabled={busy}
							onSent={text => log(text, "add")}
							onFailed={text => log(text, "del")}
							onSketchConsumed={onSketchConsumed}
						/>
						<Separator />
						<section className="bx-history" aria-label="Step history">
							<h2>History</h2>
							{steps.length === 0 ? (
								<p className="bx-empty">No steps yet.</p>
							) : (
								<ol className="bx-history-list">
									{steps.map(step => (
										<li key={step.id} data-tone={step.tone}>
											<span className="bx-mono bx-dim">{step.at}</span> {step.text}
										</li>
									))}
								</ol>
							)}
							{shownSnapshot !== null && (
								<details className="bx-snapshot">
									<summary>Latest snapshot text</summary>
									<pre className="bx-mono">{shownSnapshot}</pre>
								</details>
							)}
						</section>
					</aside>
				</div>
			)}
		</main>
	);
}

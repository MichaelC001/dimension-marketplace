// The View proper: open a profile, watch it, act on it, hand it a task,
// crop things. Every capability comes from one opaque `browserId` that arrives
// in this View's own `browser_open` tool result — there is no listing, and the
// id is held in React state only (never storage, never a URL).
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { App } from "@modelcontextprotocol/ext-apps";
import type { BrowserAction, BrowserEngine, BrowserState, TaskAgent } from "../../src/contracts";
import { BROWSER_ENGINES } from "../../src/contracts";
import { AnnotatePanel } from "./annotate-panel";
import { BrowserClient, BrowserToolError, describeAction } from "./browser-client";
import { Controls } from "./controls";
import { Badge, Button, Field, Input, Select, Separator, Spinner } from "@fraym/ui/elements"
import { TaskPanel } from "./task-panel";
import { useBrowserPoll } from "./use-browser-poll";
import { type CanvasTool, type SketchState, ViewportCanvas } from "./viewport-canvas";

const TOOLS: readonly { value: CanvasTool; label: string }[] = [
	{ value: "interact", label: "Interact" },
	{ value: "region", label: "Region" },
	{ value: "circle", label: "Circle" },
	{ value: "freehand", label: "Freehand" },
];

/** Engines the runtime refuses to start (upstream security defects). */
const REFUSED_ENGINES: readonly BrowserEngine[] = ["abp", "browser4"];

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
	const [taskStarting, setTaskStarting] = useState(false);
	const [cancelling, setCancelling] = useState(false);
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

	const annotating = tool !== "interact";
	const poll = useBrowserPoll(client, browserId, annotating);
	const state = poll.state ?? opened;
	// While an agent drives the page the runtime refuses browser_act; so does the UI.
	const taskRunning = state?.task?.status === "running";
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
	// browserId is one: everything destructive (the sketch, the
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
			setClearToken(token => token + 1);
			setTool("interact");
			loggedOpenRef.current = next.browserId;
			log(`opened ${next.profile} (${next.engine})`, "accent");
		} catch (cause) {
			if (mountedRef.current) setOpenError(failureText(cause));
		} finally {
			if (mountedRef.current) setOpening(false);
		}
	};

	/** Runs one action now. Answers true only when it completed, so a control
	 *  can keep the human's draft when it did not. */
	const act = async (action: BrowserAction): Promise<boolean> => {
		const bound = browserId;
		if (bound === null) return false;
		const what = describeAction(action);
		setBusy(true);
		setActionError(null);
		try {
			const next = await client.act(bound, action);
			if (!live(bound)) return false;
			poll.push(next);
			poll.refresh();
			log(what, "accent");
			return true;
		} catch (cause) {
			if (!live(bound)) return false;
			const detail = failureText(cause);
			setActionError(detail);
			log(`${what} failed — ${detail}`, "del");
			// A failure may still have moved the page; show what is there now.
			poll.refresh();
			return false;
		} finally {
			if (mountedRef.current) setBusy(false);
		}
	};

	/** Follows the task until it ends; the poll loop shows it live meanwhile. */
	const startTask = async (agent: TaskAgent, task: string) => {
		const bound = browserId;
		if (bound === null) return;
		setTaskStarting(true);
		setActionError(null);
		log(`task started (${agent})`, "accent");
		// Poll shortly so the running task (and the faster cadence) shows at once.
		window.setTimeout(() => poll.refresh(), 300);
		try {
			const run = await client.task(bound, agent, task);
			if (!live(bound)) return;
			log(
				`task ${run.status} after ${run.stepCount} steps${run.summary.length > 0 ? ` — ${run.summary}` : ""}`,
				run.status === "done" ? "add" : run.status === "failed" ? "del" : "mute",
			);
		} catch (cause) {
			if (!live(bound)) return;
			const detail = failureText(cause);
			setActionError(detail);
			log(`task failed — ${detail}`, "del");
		} finally {
			if (mountedRef.current) setTaskStarting(false);
			if (live(bound)) poll.refresh();
		}
	};

	const cancelTask = async () => {
		const bound = browserId;
		if (bound === null) return;
		setCancelling(true);
		try {
			await client.cancelTask(bound);
			if (live(bound)) poll.refresh();
		} catch (cause) {
			if (live(bound)) setActionError(failureText(cause));
		} finally {
			if (mountedRef.current) setCancelling(false);
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
										label: REFUSED_ENGINES.includes(value) ? `${value} — unavailable` : value,
										// Refused by the runtime over unfixed upstream security defects.
										disabled: REFUSED_ENGINES.includes(value),
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
						An address given here is opened straight away.
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
							disabled={busy || taskRunning}
							onPoint={point => void act({ kind: "click", x: point.x, y: point.y })}
							onSketchChange={onSketchChange}
							clearToken={clearToken}
						/>

						<Controls url={state?.url ?? ""} disabled={state === null || taskRunning} busy={busy} onAct={act} />
						{actionError !== null && (
							<p className="bx-error" role="alert">
								{actionError}
							</p>
						)}
					</div>

					<aside className="bx-right">
						<TaskPanel
							key={browserId}
							task={state?.task ?? null}
							disabled={state === null || busy}
							starting={taskStarting}
							cancelling={cancelling}
							onStart={(agent, task) => void startTask(agent, task)}
							onCancel={() => void cancelTask()}
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

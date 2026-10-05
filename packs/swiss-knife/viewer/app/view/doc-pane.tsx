// One open document: loads its bytes, mounts the renderer for its kind into a
// stage the renderer owns, and draws the toolbar and the loading/error states
// around it. Every open document keeps its own pane mounted (the inactive ones
// hidden), so switching tabs keeps zoom and scroll and streams nothing again.
//
// The stage wrapper is `position: relative`; the stage itself fills it. Anything
// layered over the rendered page (markup, comments) comes in through
// `./pane-extras` and is a sibling of the stage inside that wrapper
// (`data-slot="viewer-stage-frame"`), or the right-hand column after it.
import type { App } from "@modelcontextprotocol/ext-apps";
import { cn } from "@fraym/ui/lib/cn";
import { useEffect, useState } from "react";
import { MAX_MEDIA_BYTES } from "../../src/contract";
import { loadDocumentBytes, readLimit, tooLargeToPlay } from "./document-bytes";
import { shownMode } from "./annotate-modes";
import { FOCUS } from "./focus-ring";
import { formatBytes } from "./format";
import { failureAction, type FailureStage, isRecording } from "./media-failure";
import { loadRenderer } from "./renderers";
import { Opening } from "./opening";
import type { Mounted, Theme } from "./renderers/types";
import { PaneExtras } from "./pane-extras";
import type { DocTab } from "./tabs";
import { KIND_LABEL, Toolbar } from "./toolbar";
import { useCopied } from "./use-copied";
import { stepZoom } from "./zoom";

type Phase =
	| { readonly name: "loading"; readonly stage: "read" | "prepare"; readonly loaded: number; readonly total: number }
	| { readonly name: "ready" }
	| { readonly name: "unavailable" }
	| { readonly name: "too-large" }
	| { readonly name: "error"; readonly message: string; readonly stage: FailureStage };

export interface DocPaneProps {
	readonly app: App;
	readonly tab: DocTab;
	readonly active: boolean;
	readonly theme: Theme;
}

export function DocPane({ app, tab, active, theme }: DocPaneProps) {
	// State, not `useRef`: a layer on top needs to RE-RENDER when the stage or the
	// mounted renderer appears, and a ref change re-renders nothing.
	const [stage, setStage] = useState<HTMLDivElement | null>(null);
	const [frame, setFrame] = useState<HTMLDivElement | null>(null);
	const [mounted, setMounted] = useState<Mounted | null>(null);
	const [phase, setPhase] = useState<Phase>({ name: "loading", stage: "read", loaded: 0, total: tab.size });
	const [zoom, setZoom] = useState(1);
	const [page, setPage] = useState(1);
	const [retry, setRetry] = useState(0);
	const { copied, copy } = useCopied(tab.path);
	const limit = readLimit(tab);
	const truncated = limit !== undefined && tab.size > limit;
	// biome-ignore lint/correctness/useExhaustiveDependencies: `retry` is a retrigger token, and a changed file arrives as a new `revision`.
	useEffect(() => {
		if (stage === null) return;
		const controller = new AbortController();
		let handle: Mounted | undefined;
		// Where a failure is met, so a recording that cannot be played is told what to do next (`media-failure.ts`).
		let where: FailureStage = "load";
		setPhase({ name: "loading", stage: "read", loaded: 0, total: tab.size });
		setZoom(1);
		setPage(1);

		(async () => {
			try {
				// A recording past the cap is not read at all: the size is the server's, and it is decided before a byte moves.
				if (tooLargeToPlay(tab)) {
					setPhase({ name: "too-large" });
					return;
				}
				// The renderer's chunk is part of preparing, not of reading, so it loads while the bytes stream in rather
				// than before them: the opening surface names the stage that is really under way, and `prepare` starts the
				// moment the bytes are in hand.
				const reading = loadDocumentBytes(app, tab, {
					signal: controller.signal,
					onProgress: (done, total) => setPhase({ name: "loading", stage: "read", loaded: done, total }),
				}).then(loaded => {
					if (!controller.signal.aborted) setPhase({ name: "loading", stage: "prepare", loaded: loaded.bytes.length, total: tab.size });
					return loaded;
				});
				const [renderer, { bytes }] = await Promise.all([loadRenderer(tab.kind), reading]);
				if (controller.signal.aborted) return;
				if (renderer === null) {
					setPhase({ name: "unavailable" });
					return;
				}
				where = "open";
				handle = await renderer.mount(stage, bytes, {
					filename: tab.filename,
					theme,
					onPage: setPage,
					openLink: url => {
						void app.openLink({ url }).catch(() => undefined);
					},
					signal: controller.signal,
				});
				if (controller.signal.aborted) {
					handle.destroy();
					return;
				}
				setMounted(handle);
				setPhase({ name: "ready" });
			} catch (error) {
				if (controller.signal.aborted) return;
				setPhase({ name: "error", message: error instanceof Error ? error.message : String(error), stage: where });
				// The read may still be streaming (the renderer failed first): stop it, so its `prepare` cannot take the error card back.
				controller.abort();
			}
		})();

		return () => {
			controller.abort();
			handle?.destroy();
			setMounted(null);
			stage.replaceChildren();
		};
	}, [app, stage, tab.key, tab.revision, tab.kind, tab.path, tab.filename, tab.size, tab.mtimeMs, theme, retry]);

	const pages = mounted?.goto !== undefined && mounted.pageCount !== undefined && mounted.pageCount > 1 ? mounted.pageCount : 0;
	const applyZoom = (next: number) => {
		setZoom(next);
		mounted?.zoom?.(next);
	};
	const goto = (next: number) => {
		setPage(next);
		mounted?.goto?.(next);
	};

	// A document that did not open has nothing to mark, whatever its kind: no marking help, list or send under its error
	// card. For a recording the card also offers what can help: Copy path when a retry cannot (`media-failure.ts`).
	const modeShown = shownMode(tab.kind, phase.name);
	const retryAction = { label: "Try again", onClick: () => setRetry(count => count + 1) };
	const copyAction = { label: copied ? "Path copied" : "Copy path", onClick: copy };

	return (
		<div className={active ? "relative flex h-full min-h-0 flex-col" : "hidden"} data-slot="viewer-pane" data-key={tab.key} data-annotate={modeShown ?? undefined}>
			<Toolbar
				filename={tab.filename}
				path={tab.path}
				kind={tab.kind}
				size={tab.size}
				shownBytes={truncated ? limit : undefined}
				zoom={mounted?.zoom ? { factor: zoom, onStep: direction => applyZoom(stepZoom(zoom, direction)), onReset: () => applyZoom(1) } : undefined}
				pager={pages > 1 ? { page, count: pages, onGoto: goto } : undefined}
			/>
			<div className="flex min-h-0 flex-1">
				<div className="relative min-h-0 min-w-0 flex-1" data-slot="viewer-stage-frame" ref={setFrame}>
					<div ref={setStage} className="absolute inset-0 overflow-hidden" data-slot="viewer-stage" />
					{phase.name === "loading" || phase.name === "ready" ? (
						<Opening
							name={tab.filename}
							stage={phase.name === "loading" ? phase.stage : "prepare"}
							loaded={phase.name === "loading" ? phase.loaded : undefined}
							total={phase.name === "loading" ? phase.total : undefined}
							open={phase.name === "loading"}
						/>
					) : null}
					{phase.name === "unavailable" ? (
						<Message title="Preview not available" body={`${KIND_LABEL[tab.kind]} files cannot be previewed in this build of the viewer.`} />
					) : null}
					{phase.name === "too-large" ? (
						<Message
							title="Too large to play here"
							body={`The viewer plays recordings up to ${formatBytes(MAX_MEDIA_BYTES)}, and this one is ${formatBytes(tab.size)}. Copy its path to open it in a media player.`}
							action={copyAction}
						/>
					) : null}
					{phase.name === "error" ? (
						<Message
							title="This file could not be shown"
							body={phase.message}
							action={isRecording(tab.kind) && failureAction({ where: phase.stage, message: phase.message }) === "copy-path" ? copyAction : retryAction}
						/>
					) : null}
				</div>
				<PaneExtras app={app} tab={tab} active={active} ready={phase.name === "ready"} frame={frame} mode={modeShown} />
			</div>
		</div>
	);
}

/**
 * The pane for a file that did not open (`tab.failure`): its name in the bar, why in one sentence, and the way out when
 * there is one. Nothing is read and nothing can be marked, so none of a document's machinery is mounted.
 */
export function FailedPane({ tab, failure, active }: { readonly tab: DocTab; readonly failure: NonNullable<DocTab["failure"]>; readonly active: boolean }) {
	const { copied, copy } = useCopied(tab.path);
	return (
		<div className={active ? "flex h-full min-h-0 flex-col" : "hidden"} data-slot="viewer-pane" data-key={tab.key} data-failed="">
			<Toolbar filename={tab.filename} path={tab.path} />
			<div className="relative min-h-0 flex-1">
				<Message title="This file could not be opened" body={failure.message} action={failure.copyPath ? { label: copied ? "Path copied" : "Copy path", onClick: copy } : undefined} />
			</div>
		</div>
	);
}

export function Message({ title, body, action }: { readonly title: string; readonly body: string; readonly action?: { readonly label: string; readonly onClick: () => void } }) {
	return (
		<div role="alert" className="absolute inset-0 flex flex-col items-center justify-center gap-1.5 bg-fr-bg px-6 text-center">
			<p className="text-fr-md font-semibold text-fr-text">{title}</p>
			<p className="max-w-[44ch] text-fr-sm text-fr-text-2 [overflow-wrap:anywhere]">{body}</p>
			{action ? (
				<button
					type="button"
					onClick={action.onClick}
					className={cn("mt-2 rounded-md border border-fr-border px-3 py-1.5 text-fr-sm text-fr-text-2 hover:bg-fr-surface hover:text-fr-text", FOCUS)}
				>
					{action.label}
				</button>
			) : null}
		</div>
	);
}

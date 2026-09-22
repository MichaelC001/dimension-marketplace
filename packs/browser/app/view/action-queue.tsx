// The approval queue. Nothing here is ever decided for the human: each pending
// action shows exactly what was requested, by request id, and moves only when a
// human presses Approve or Deny — which calls the app-only, destructive
// `browser_resolve_action`, so the HOST prompts again on top of this.
//
// The state this View holds is the runtime's REDACTED copy: typed text reads
// `[redacted]` there, so the one-liner cannot describe it. Before an approval
// is possible the human must pull the exact executable payload with the
// app-only `browser_action_preview` — shown here, held in this component only,
// never logged, never persisted, never sent back. Approval travels as the
// immutable `actionId`; the previewed payload is never handed to the runtime.
import { useEffect, useRef, useState } from "react";
import type { BrowserAction, PendingAction } from "../../src/contracts";
import { Badge, Button } from "@fraym/ui/elements"
import { describeAction } from "./browser-client";

const TONES: Record<PendingAction["status"], "accent" | "add" | "blue" | "warn" | "mute" | "del"> = {
	pending: "warn",
	claimed: "blue",
	completed: "add",
	denied: "mute",
	failed: "del",
	unknown: "mute",
};

/** Every field of the exact payload, as label/value pairs for inspection. */
function exactFields(action: BrowserAction): readonly { label: string; value: string }[] {
	switch (action.kind) {
		case "navigate":
			return [{ label: "url", value: action.url ?? "(none)" }];
		case "click":
			return action.selector !== undefined
				? [{ label: "selector", value: action.selector }]
				: [{ label: "x", value: String(action.x ?? 0) }, { label: "y", value: String(action.y ?? 0) }];
		case "type":
			return [
				{ label: "selector", value: action.selector ?? "(none)" },
				{ label: "text", value: action.text ?? "" },
			];
		case "press":
			return [{ label: "key", value: action.key ?? "(none)" }];
		case "scroll":
			return [
				{ label: "deltaX", value: String(action.deltaX ?? 0) },
				{ label: "deltaY", value: String(action.deltaY ?? 0) },
			];
	}
}

export interface ActionQueueProps {
	readonly actions: readonly PendingAction[];
	/** The action id currently being resolved, so its buttons show the wait. */
	readonly resolving: string | null;
	readonly disabled: boolean;
	readonly onResolve: (actionId: string, approve: boolean) => void;
	/** Reads the exact executable payload for one pending action, app-only. */
	readonly onPreview: (actionId: string) => Promise<BrowserAction>;
}

export function ActionQueue({ actions, resolving, disabled, onResolve, onPreview }: ActionQueueProps) {
	const pending = actions.filter(action => action.status === "pending");
	// The exact payloads the human has pulled, keyed by the immutable action id.
	// Component state only: nothing here is lifted, logged or persisted.
	const [previews, setPreviews] = useState<ReadonlyMap<string, BrowserAction>>(() => new Map());
	const [previewing, setPreviewing] = useState<string | null>(null);
	const [previewErrors, setPreviewErrors] = useState<ReadonlyMap<string, string>>(() => new Map());
	const mounted = useRef(true);
	useEffect(() => {
		mounted.current = true;
		return () => {
			mounted.current = false;
		};
	}, []);

	// A revealed payload lives exactly as long as the approval it is for: once
	// the action settles (or the queue is re-targeted at another browser) the
	// text disappears from the screen and from this component's memory.
	const pendingKey = pending.map(action => action.id).join("\u0000");
	useEffect(() => {
		const live = new Set(pendingKey.length === 0 ? [] : pendingKey.split("\u0000"));
		const prune = <T,>(current: ReadonlyMap<string, T>): ReadonlyMap<string, T> => {
			const kept = [...current].filter(([id]) => live.has(id));
			return kept.length === current.size ? current : new Map(kept);
		};
		setPreviews(prune);
		setPreviewErrors(prune);
	}, [pendingKey]);

	const reveal = async (actionId: string) => {
		setPreviewing(actionId);
		setPreviewErrors(current => {
			if (!current.has(actionId)) return current;
			const next = new Map(current);
			next.delete(actionId);
			return next;
		});
		try {
			const action = await onPreview(actionId);
			if (!mounted.current) return;
			setPreviews(current => new Map(current).set(actionId, action));
		} catch (cause) {
			if (!mounted.current) return;
			const detail = cause instanceof Error ? cause.message : String(cause);
			setPreviews(current => {
				if (!current.has(actionId)) return current;
				const next = new Map(current);
				next.delete(actionId);
				return next;
			});
			setPreviewErrors(current => new Map(current).set(actionId, detail));
		} finally {
			if (mounted.current) setPreviewing(null);
		}
	};

	return (
		<section className="bx-queue" aria-label="Pending actions">
			<header className="bx-queue-head">
				<h2>Action queue</h2>
				<Badge tone={pending.length > 0 ? "warn" : "mute"} variant="soft">
					{pending.length} awaiting you
				</Badge>
			</header>
			{actions.length === 0 ? (
				<p className="bx-empty">Nothing requested yet. Agent and human requests both land here first.</p>
			) : (
				<ul className="bx-queue-list">
					{actions.map(action => {
						const preview = action.status === "pending" ? previews.get(action.id) : undefined;
						const previewError = previewErrors.get(action.id);
						return (
							<li key={action.id} className="bx-queue-item" data-status={action.status}>
								<div className="bx-queue-main">
									<p className="bx-queue-what">{describeAction(action.action)}</p>
									<p className="bx-queue-meta">
										<Badge tone={TONES[action.status]} variant="soft">
											{action.status}
										</Badge>
										<span className="bx-mono">request {action.requestId}</span>
										<span className="bx-mono">rev {action.revision}</span>
									</p>
									{preview !== undefined && (
										<dl className="bx-queue-exact" aria-label="Exact request payload">
											{exactFields(preview).map(field => (
												<div key={field.label}>
													<dt className="bx-mono bx-dim">{field.label}</dt>
													<dd className="bx-mono">{field.value.length > 0 ? field.value : "(empty)"}</dd>
												</div>
											))}
										</dl>
									)}
									{previewError !== undefined && (
										<p className="bx-queue-error" role="alert">
											{previewError}
										</p>
									)}
									{action.error !== undefined && action.error.length > 0 && (
										<p className="bx-queue-error" role="alert">
											{action.error}
										</p>
									)}
								</div>
								{action.status === "pending" && (
									<div className="bx-queue-actions">
										<Button
											size="sm"
											variant="outline"
											disabled={disabled || previewing !== null || resolving !== null}
											loading={previewing === action.id}
											loadingText="Reading…"
											onClick={() => void reveal(action.id)}
										>
											{preview === undefined ? "Show exact request" : "Re-read"}
										</Button>
										<Button
											size="sm"
											disabled={disabled || resolving !== null || preview === undefined}
											loading={resolving === action.id}
											loadingText="Approving…"
											onClick={() => onResolve(action.id, true)}
										>
											Approve
										</Button>
										<Button
											size="sm"
											variant="destructive"
											disabled={disabled || resolving !== null}
											onClick={() => onResolve(action.id, false)}
										>
											Deny
										</Button>
									</div>
								)}
							</li>
						);
					})}
				</ul>
			)}
			<p className="bx-note">
				Approve unlocks only after you read the exact request — the queue line above is the runtime's redacted
				copy, so typed text is not in it. What you read here is shown and dropped: it is never written to the
				history, never sent to the agent, and never handed back to the browser. Approving asks the host to
				confirm as well — this View never resolves an action on its own.
			</p>
		</section>
	);
}

import { Button, ChainRow, DiffStat, Icon, Input, StateGlyph, ThreadCard, cn, resolveReviewChains, reviewListLines, useObservable, useStandardSessionFacts, visibleReviews } from "@fraym/ui";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Fragment, jsx, jsxs } from "react/jsx-runtime";
//#region src/model.ts
function refKey(ref) {
	return `${ref.provider}:${ref.host}/${ref.repository}#${ref.number}`;
}
/** The three-word footer: how much is live · how much is attached · how much
*  to trust the screen (doc 73 §10). An unsynced link counts as open. */
function footerLine(links, now = Date.now()) {
	const open = links.filter((link) => link.snapshot === null || link.snapshot.state === "open").length;
	let latest = null;
	for (const link of links) {
		const at = link.snapshot?.syncedAt;
		if (at !== void 0 && (latest === null || at > latest)) latest = at;
	}
	const synced = latest === null ? "" : ` · synced ${relativeTime(latest, now)}`;
	return `${open} open · ${links.length} linked${synced}`;
}
function relativeTime(iso, now = Date.now()) {
	const at = Date.parse(iso);
	if (!Number.isFinite(at)) return "";
	const seconds = Math.max(0, Math.round((now - at) / 1e3));
	if (seconds < 45) return "just now";
	const minutes = Math.round(seconds / 60);
	if (minutes < 60) return `${minutes}m ago`;
	const hours = Math.round(minutes / 60);
	if (hours < 24) return `${hours}h ago`;
	return `${Math.round(hours / 24)}d ago`;
}
/** A pasted review: a full URL on any host the checkout can reach, or a bare
*  `#123` / `123` against the checkout's own repository. Returns null for
*  anything else — the dialog states why. */
function parseLinkInput(raw, own) {
	const text = raw.trim();
	const bare = /^#?(\d+)$/.exec(text);
	if (bare) {
		const number = Number(bare[1]);
		if (!own || !Number.isSafeInteger(number) || number <= 0) return null;
		return {
			ref: {
				...own,
				number
			},
			url: `https://${own.host}/${own.repository}/${own.provider === "gitlab" ? "-/merge_requests" : "pull"}/${number}`
		};
	}
	let url;
	try {
		url = new URL(text);
	} catch {
		return null;
	}
	if (url.protocol !== "https:" && url.protocol !== "http:") return null;
	const host = url.host.toLowerCase();
	const gh = /^\/([^/]+\/[^/]+)\/pulls?\/(\d+)/.exec(url.pathname);
	const gl = /^\/(.+?)\/-\/merge_requests\/(\d+)/.exec(url.pathname);
	const match = gh ?? gl;
	if (!match?.[1] || !match[2]) return null;
	const number = Number(match[2]);
	if (!Number.isSafeInteger(number) || number <= 0) return null;
	return {
		ref: {
			provider: gl ? "gitlab" : host === "github.com" || host.endsWith(".ghe.com") ? "github" : own?.provider ?? "github",
			host,
			repository: match[1].toLowerCase(),
			number
		},
		url: url.href
	};
}
//#endregion
//#region src/pr-viewer.tsx
var NO_LINKS = [];
var NO_ROWS = [];
var NONE = {
	getSnapshot: () => void 0,
	subscribe: () => () => {}
};
/** State → ink, ONE place: a review cannot look like two things in two rows. */
function stateGlyph(summary) {
	if (summary === null) return {
		tone: "muted",
		icon: "branch",
		label: "Not synced yet"
	};
	if (summary.state === "merged") return {
		tone: "accent",
		icon: "check",
		label: "Merged"
	};
	if (summary.state === "closed") return {
		tone: "negative",
		icon: "x",
		label: "Closed"
	};
	if (summary.isDraft) return {
		tone: "muted",
		icon: "edit",
		label: "Draft"
	};
	if (summary.mergeability === "conflicting") return {
		tone: "warning",
		icon: "warnTri",
		label: "Conflicts"
	};
	return {
		tone: "positive",
		icon: "branch",
		label: "Open"
	};
}
function checksGlyph(state) {
	if (state === void 0 || state === null) return null;
	return /* @__PURE__ */ jsx(StateGlyph, {
		tone: state === "passing" ? "positive" : state === "failing" ? "negative" : "warning",
		icon: /* @__PURE__ */ jsx(Icon, {
			name: state === "passing" ? "check" : state === "failing" ? "x" : "clock",
			size: 12
		}),
		label: state === "passing" ? "All checks passed" : state === "failing" ? "Some checks failed" : "Checks running"
	});
}
function sourceLabel(source) {
	return source === "created" ? "created by this session" : source === "pushed" ? "this session pushed to it" : source === "agent" ? "the agent acted on it" : source === "stack" ? "a stack sibling" : "linked by you";
}
function ReviewRow({ summary, link, depth, stack, selected, onSelect, menu }) {
	const glyph = stateGlyph(summary);
	const ref = summary?.ref ?? link?.ref;
	const label = summary?.label ?? "review";
	return /* @__PURE__ */ jsxs(ChainRow, {
		depth,
		className: cn("group rounded-sm", selected && "bg-fr-surface-2"),
		"data-selected": selected,
		children: [/* @__PURE__ */ jsxs("button", {
			type: "button",
			onClick: onSelect,
			className: "flex min-w-0 flex-1 flex-col gap-0.5 py-1.5 text-left",
			children: [/* @__PURE__ */ jsxs("span", {
				className: "flex min-w-0 items-center gap-1.5",
				children: [
					/* @__PURE__ */ jsx(StateGlyph, {
						tone: glyph.tone,
						icon: /* @__PURE__ */ jsx(Icon, {
							name: glyph.icon,
							size: 13
						}),
						label: glyph.label
					}),
					/* @__PURE__ */ jsxs("span", {
						className: "font-secondary text-fr-xs text-fr-text-3 tabular-nums",
						title: link ? sourceLabel(link.source) : void 0,
						children: [
							label,
							" #",
							ref?.number
						]
					}),
					/* @__PURE__ */ jsx("span", {
						className: "min-w-0 flex-1 truncate text-fr-sm text-fr-text",
						children: summary?.title ?? link?.url ?? ""
					}),
					summary?.reviewDecision === "changes-requested" ? /* @__PURE__ */ jsx("span", {
						className: "font-secondary text-fr-2xs text-fr-warn",
						children: "changes requested"
					}) : null,
					checksGlyph(summary?.checksState),
					/* @__PURE__ */ jsx(DiffStat, {
						additions: summary?.additions,
						deletions: summary?.deletions
					})
				]
			}), /* @__PURE__ */ jsxs("span", {
				className: "flex min-w-0 items-center gap-2 font-secondary text-fr-2xs text-fr-text-3",
				children: [
					stack ? /* @__PURE__ */ jsxs("span", {
						className: "inline-flex items-center gap-0.5",
						title: stack.kind === "native" ? `Host stack of ${stack.size}: merging a layer lands the ones below it` : `${stack.size} reviews chained by base branch`,
						children: [/* @__PURE__ */ jsx(Icon, {
							name: stack.kind === "native" ? "layers" : "branch",
							size: 11
						}), stack.size]
					}) : null,
					summary?.author ? /* @__PURE__ */ jsx("span", {
						className: "truncate",
						children: summary.author.login
					}) : null,
					/* @__PURE__ */ jsx("span", {
						className: "truncate font-mono",
						children: summary ? `${summary.headBranch} → ${summary.baseBranch}` : ref ? `${ref.host}/${ref.repository}` : ""
					}),
					summary ? /* @__PURE__ */ jsx("span", {
						className: "ml-auto shrink-0",
						children: relativeTime(summary.updatedAt)
					}) : null
				]
			})]
		}), /* @__PURE__ */ jsx("span", {
			className: "opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100",
			children: menu
		})]
	});
}
function RowMenu({ actions }) {
	const [open, setOpen] = useState(false);
	if (actions.length === 0) return null;
	return /* @__PURE__ */ jsxs("span", {
		className: "relative",
		children: [/* @__PURE__ */ jsx(Button, {
			size: "icon",
			variant: "ghost",
			"aria-label": "Row actions",
			onClick: () => setOpen((v) => !v),
			children: /* @__PURE__ */ jsx(Icon, {
				name: "dots",
				size: 13
			})
		}), open ? /* @__PURE__ */ jsx("span", {
			className: "absolute right-0 z-10 mt-1 flex min-w-36 flex-col rounded-md border border-fr-border bg-fr-surface p-1 shadow-fr",
			children: actions.map((action) => /* @__PURE__ */ jsx("button", {
				type: "button",
				className: "rounded-sm px-2 py-1 text-left text-fr-sm text-fr-text hover:bg-fr-surface-2",
				onClick: () => {
					setOpen(false);
					action.onClick();
				},
				children: action.label
			}, action.label))
		}) : null]
	});
}
function LinkDialog({ own, onSubmit, onClose }) {
	const [text, setText] = useState("");
	const parsed = useMemo(() => parseLinkInput(text, own), [text, own]);
	const reason = text.trim() === "" ? null : parsed ? null : /^#?\d+$/.test(text.trim()) ? "This checkout has no review host; paste a full URL." : "Paste a review URL, or #123 for this repository.";
	return /* @__PURE__ */ jsxs("div", {
		className: "flex flex-col gap-2 border-fr-border border-b p-2",
		children: [
			/* @__PURE__ */ jsx(Input, {
				autoFocus: true,
				value: text,
				placeholder: "https://… or #123",
				onChange: (event) => setText(event.target.value),
				onKeyDown: (event) => {
					if (event.key === "Escape") onClose();
					if (event.key === "Enter" && parsed) onSubmit(parsed.ref, parsed.url);
				}
			}),
			reason ? /* @__PURE__ */ jsx("span", {
				className: "font-secondary text-fr-2xs text-fr-warn",
				children: reason
			}) : null,
			/* @__PURE__ */ jsxs("div", {
				className: "flex justify-end gap-1",
				children: [/* @__PURE__ */ jsx(Button, {
					size: "sm",
					variant: "ghost",
					onClick: onClose,
					children: "Cancel"
				}), /* @__PURE__ */ jsx(Button, {
					size: "sm",
					disabled: !parsed,
					onClick: () => parsed && onSubmit(parsed.ref, parsed.url),
					children: "Link to this session"
				})]
			})
		]
	});
}
function useRead(read, key) {
	const [state, setState] = useState({
		key,
		value: null,
		error: null,
		loading: read !== null
	});
	useEffect(() => {
		if (!read) return;
		let live = true;
		setState({
			key,
			value: null,
			error: null,
			loading: true
		});
		read().then((value) => live && setState({
			key,
			value,
			error: null,
			loading: false
		}), (error) => live && setState({
			key,
			value: null,
			error: error instanceof Error ? error.message : String(error),
			loading: false
		}));
		return () => {
			live = false;
		};
	}, [key, read]);
	return state.key === key ? state : {
		value: null,
		error: null,
		loading: read !== null
	};
}
function DetailView({ ref, summary, link, workspace, driver, act, onBack }) {
	const key = refKey(ref);
	const readDetail = useCallback(() => driver.getReview ? driver.getReview(workspace, ref) : Promise.reject(/* @__PURE__ */ new Error("This host offers no detail")), [
		driver,
		workspace,
		ref
	]);
	const readThreads = useCallback(() => driver.getReviewThreads ? driver.getReviewThreads(workspace, ref) : Promise.resolve([]), [
		driver,
		workspace,
		ref
	]);
	const readDiff = useCallback(() => driver.getReviewDiff ? driver.getReviewDiff(workspace, ref) : Promise.resolve({
		files: [],
		truncated: false
	}), [
		driver,
		workspace,
		ref
	]);
	const detail = useRead(driver.getReview ? readDetail : null, key);
	const [tab, setTab] = useState("summary");
	const threads = useRead(tab === "threads" && driver.getReviewThreads ? readThreads : null, `${key}:threads`);
	const diff = useRead(tab === "diff" && driver.getReviewDiff ? readDiff : null, `${key}:diff`);
	const [folded, setFolded] = useState({});
	const head = detail.value ?? summary;
	const glyph = stateGlyph(head);
	const stack = detail.value?.stack ?? link?.stack ?? null;
	const canMerge = head?.state === "open" && !head.isDraft && (detail.value?.viewer.merge ?? false) && (head.capabilities.merge ?? false);
	const stackHeads = stack?.layers.filter((layer) => layer.state === "open" && layer.headSha).map((layer) => ({
		number: layer.number,
		headSha: layer.headSha
	})) ?? [];
	const stackLayersBelow = stack ? stack.layers.slice(0, stack.layers.findIndex((layer) => layer.number === ref.number) + 1).filter((layer) => layer.state !== "merged") : [];
	const canStackMerge = canMerge && stack !== null && head?.capabilities.stackActions === true && stackLayersBelow.length > 1 && stackLayersBelow.every((layer) => layer.headSha && !layer.isDraft);
	const canStackRebase = stack !== null && head?.capabilities.stackActions === true && (detail.value?.viewer.stackRebase ?? false) && stackHeads.length > 0;
	return /* @__PURE__ */ jsxs("div", {
		className: "flex min-h-0 flex-1 flex-col",
		children: [
			/* @__PURE__ */ jsxs("header", {
				className: "flex items-center gap-2 border-fr-border border-b px-2 py-1.5",
				children: [
					onBack ? /* @__PURE__ */ jsx(Button, {
						size: "icon",
						variant: "ghost",
						"aria-label": "Back to this session's reviews",
						onClick: onBack,
						children: /* @__PURE__ */ jsx(Icon, {
							name: "back",
							size: 13
						})
					}) : null,
					/* @__PURE__ */ jsx(StateGlyph, {
						tone: glyph.tone,
						icon: /* @__PURE__ */ jsx(Icon, {
							name: glyph.icon,
							size: 13
						}),
						label: glyph.label
					}),
					/* @__PURE__ */ jsxs("span", {
						className: "font-secondary text-fr-xs text-fr-text-3 tabular-nums",
						children: [
							head?.label ?? "review",
							" #",
							ref.number
						]
					}),
					/* @__PURE__ */ jsx("span", {
						className: "min-w-0 flex-1 truncate text-fr-sm text-fr-text",
						children: head?.title ?? ""
					}),
					checksGlyph(head?.checksState),
					/* @__PURE__ */ jsx(DiffStat, {
						additions: head?.additions,
						deletions: head?.deletions
					}),
					/* @__PURE__ */ jsx(Button, {
						size: "icon",
						variant: "ghost",
						"aria-label": "Open on the host",
						onClick: () => act("openReview", {
							ref,
							url: head?.url ?? link?.url ?? ""
						}),
						children: /* @__PURE__ */ jsx(Icon, {
							name: "external",
							size: 13
						})
					})
				]
			}),
			/* @__PURE__ */ jsx("nav", {
				className: "flex gap-1 border-fr-border border-b px-2 py-1 font-secondary text-fr-xs",
				children: [
					"summary",
					"threads",
					"diff"
				].map((name) => /* @__PURE__ */ jsx("button", {
					type: "button",
					onClick: () => setTab(name),
					className: cn("rounded-sm px-2 py-0.5 capitalize", tab === name ? "bg-fr-surface-2 text-fr-text" : "text-fr-text-3 hover:text-fr-text"),
					children: name
				}, name))
			}),
			/* @__PURE__ */ jsxs("div", {
				className: "min-h-0 flex-1 overflow-y-auto p-2",
				children: [
					detail.error ? /* @__PURE__ */ jsx("p", {
						className: "text-fr-del text-fr-sm",
						children: detail.error
					}) : null,
					tab === "summary" ? /* @__PURE__ */ jsxs("div", {
						className: "flex flex-col gap-3",
						children: [stack ? /* @__PURE__ */ jsxs("section", {
							className: "flex flex-col gap-1 rounded-md border border-fr-border p-2",
							children: [
								/* @__PURE__ */ jsxs("span", {
									className: "font-secondary text-fr-2xs text-fr-text-3",
									children: [
										"Stack · ",
										stack.layers.length,
										" layers on ",
										stack.base
									]
								}),
								[...stack.layers].reverse().map((layer) => /* @__PURE__ */ jsxs("span", {
									className: cn("flex items-center gap-2 text-fr-xs", layer.number === ref.number ? "text-fr-text" : "text-fr-text-2"),
									children: [
										/* @__PURE__ */ jsx(StateGlyph, {
											...stateGlyph({
												state: layer.state,
												isDraft: layer.isDraft ?? false
											}),
											icon: /* @__PURE__ */ jsx(Icon, {
												name: stateGlyph({
													state: layer.state,
													isDraft: layer.isDraft ?? false
												}).icon,
												size: 11
											})
										}),
										/* @__PURE__ */ jsxs("span", {
											className: "tabular-nums",
											children: ["#", layer.number]
										}),
										/* @__PURE__ */ jsx("span", {
											className: "min-w-0 flex-1 truncate",
											children: layer.title ?? layer.headBranch
										})
									]
								}, layer.number)),
								/* @__PURE__ */ jsxs("span", {
									className: "flex gap-1 pt-1",
									children: [canStackMerge ? /* @__PURE__ */ jsxs(Button, {
										size: "sm",
										variant: "outline",
										onClick: () => act("reviewAction", {
											ref,
											action: "merge",
											stackNumber: stack.number,
											expectedStackHeads: stackLayersBelow.map((layer) => ({
												number: layer.number,
												headSha: layer.headSha
											}))
										}),
										children: [
											"Merge stack (",
											stackLayersBelow.length,
											")"
										]
									}) : null, canStackRebase ? /* @__PURE__ */ jsx(Button, {
										size: "sm",
										variant: "outline",
										onClick: () => act("reviewAction", {
											ref,
											action: "update-branch",
											stackNumber: stack.number,
											expectedStackHeads: stackHeads
										}),
										children: "Rebase stack"
									}) : null]
								})
							]
						}) : null, detail.value ? /* @__PURE__ */ jsxs(Fragment, { children: [
							detail.value.labels.length > 0 ? /* @__PURE__ */ jsx("div", {
								className: "flex flex-wrap gap-1",
								children: detail.value.labels.map((label) => /* @__PURE__ */ jsx("span", {
									className: "rounded-full border border-fr-border px-2 font-secondary text-fr-2xs text-fr-text-2",
									children: label.name
								}, label.name))
							}) : null,
							detail.value.reviewers.length > 0 ? /* @__PURE__ */ jsxs("span", {
								className: "font-secondary text-fr-2xs text-fr-text-3",
								children: ["Reviewers · ", detail.value.reviewers.map((r) => r.login).join(", ")]
							}) : null,
							detail.value.checks.length > 0 ? /* @__PURE__ */ jsx("ul", {
								className: "flex flex-col gap-0.5 font-secondary text-fr-xs",
								children: detail.value.checks.map((check) => /* @__PURE__ */ jsxs("li", {
									className: "flex items-center gap-2",
									children: [/* @__PURE__ */ jsx("span", {
										className: cn("tabular-nums", check.status === "success" ? "text-fr-add" : check.status === "failure" ? "text-fr-del" : "text-fr-text-3"),
										children: check.status
									}), /* @__PURE__ */ jsx("span", {
										className: "min-w-0 truncate",
										children: check.name
									})]
								}, check.name))
							}) : null,
							/* @__PURE__ */ jsx("pre", {
								className: "whitespace-pre-wrap font-primary text-fr-sm text-fr-text-2",
								children: detail.value.body
							}),
							/* @__PURE__ */ jsxs("span", {
								className: "flex flex-wrap gap-1",
								children: [
									canMerge && !canStackMerge ? /* @__PURE__ */ jsx(Button, {
										size: "sm",
										onClick: () => act("reviewAction", {
											ref,
											action: "merge",
											mergeMethod: detail.value?.allowedMergeMethods[0]
										}),
										children: "Merge"
									}) : null,
									head?.state === "open" && head.isDraft && head.capabilities.draft ? /* @__PURE__ */ jsx(Button, {
										size: "sm",
										variant: "outline",
										onClick: () => act("reviewAction", {
											ref,
											action: "ready"
										}),
										children: "Ready for review"
									}) : null,
									head?.state === "open" ? /* @__PURE__ */ jsx(Button, {
										size: "sm",
										variant: "ghost",
										onClick: () => act("reviewAction", {
											ref,
											action: "close"
										}),
										children: "Close"
									}) : null,
									head?.state === "closed" ? /* @__PURE__ */ jsx(Button, {
										size: "sm",
										variant: "ghost",
										onClick: () => act("reviewAction", {
											ref,
											action: "reopen"
										}),
										children: "Reopen"
									}) : null
								]
							})
						] }) : detail.loading ? /* @__PURE__ */ jsx("span", {
							className: "font-secondary text-fr-xs text-fr-text-3",
							children: "Loading…"
						}) : null]
					}) : null,
					tab === "threads" ? /* @__PURE__ */ jsxs("div", {
						className: "flex flex-col gap-2",
						children: [
							threads.loading ? /* @__PURE__ */ jsx("span", {
								className: "font-secondary text-fr-xs text-fr-text-3",
								children: "Loading…"
							}) : null,
							threads.error ? /* @__PURE__ */ jsx("p", {
								className: "text-fr-del text-fr-sm",
								children: threads.error
							}) : null,
							(threads.value ?? []).map((thread) => /* @__PURE__ */ jsxs("div", {
								className: "flex flex-col gap-1",
								children: [/* @__PURE__ */ jsxs("span", {
									className: "font-secondary text-fr-2xs text-fr-text-3",
									children: [
										thread.path ? `${thread.path}${thread.line ? `:${thread.line}` : ""}` : "no longer on a line",
										thread.isResolved ? " · resolved" : "",
										thread.isOutdated ? " · outdated" : ""
									]
								}), /* @__PURE__ */ jsx(ThreadCard, {
									comments: thread.comments.map((comment) => ({
										id: comment.id,
										author: comment.author,
										body: comment.body,
										at: relativeTime(comment.createdAt)
									})),
									folded: folded[thread.id] ?? thread.isResolved,
									onToggleFolded: () => setFolded((prev) => ({
										...prev,
										[thread.id]: !(prev[thread.id] ?? thread.isResolved)
									}))
								})]
							}, thread.id)),
							threads.value && threads.value.length === 0 ? /* @__PURE__ */ jsx("span", {
								className: "font-secondary text-fr-xs text-fr-text-3",
								children: "No review conversations."
							}) : null
						]
					}) : null,
					tab === "diff" ? /* @__PURE__ */ jsxs("div", {
						className: "flex flex-col gap-2",
						children: [
							diff.loading ? /* @__PURE__ */ jsx("span", {
								className: "font-secondary text-fr-xs text-fr-text-3",
								children: "Loading…"
							}) : null,
							diff.error ? /* @__PURE__ */ jsx("p", {
								className: "text-fr-del text-fr-sm",
								children: diff.error
							}) : null,
							(diff.value?.files ?? []).map((file) => /* @__PURE__ */ jsxs("details", {
								className: "rounded-md border border-fr-border",
								children: [/* @__PURE__ */ jsxs("summary", {
									className: "flex cursor-pointer items-center gap-2 px-2 py-1 font-secondary text-fr-xs",
									children: [/* @__PURE__ */ jsx("span", {
										className: "min-w-0 flex-1 truncate font-mono",
										children: file.path
									}), /* @__PURE__ */ jsx(DiffStat, {
										additions: file.additions,
										deletions: file.deletions
									})]
								}), file.patch ? /* @__PURE__ */ jsx("pre", {
									className: "overflow-x-auto px-2 py-1 font-mono text-fr-2xs text-fr-text-2",
									children: file.patch
								}) : /* @__PURE__ */ jsx("span", {
									className: "px-2 py-1 font-secondary text-fr-2xs text-fr-text-3",
									children: "Hunks withheld by the host."
								})]
							}, file.path)),
							diff.value?.truncated ? /* @__PURE__ */ jsx("span", {
								className: "font-secondary text-fr-2xs text-fr-text-3",
								children: "More files than the host returned — open on the host for the rest."
							}) : null
						]
					}) : null
				]
			})
		]
	});
}
function PrViewer({ sessionId, workspace, workspaceDriver, store }) {
	const facts = useStandardSessionFacts(sessionId);
	const links = useMemo(() => visibleReviews(facts.reviews ?? NO_LINKS), [facts.reviews]);
	const checkout = useObservable(useMemo(() => store && workspace ? store.watch(`workspace/${workspace.workspaceId}/reviews`) : NONE, [store, workspace]));
	const lines = useMemo(() => reviewListLines(resolveReviewChains(links)), [links]);
	const linkedKeys = useMemo(() => new Set(links.map((link) => refKey(link.ref))), [links]);
	const others = useMemo(() => (checkout ?? NO_ROWS).filter((row) => !linkedKeys.has(refKey(row.ref))), [checkout, linkedKeys]);
	const [selected, setSelected] = useState(null);
	const [linking, setLinking] = useState(false);
	const act = useCallback((intent, payload) => {
		if (!store) return;
		store.act(intent, {
			...payload,
			...workspace ? { env: workspace } : {},
			...sessionId ? { sessionId } : {}
		});
	}, [
		store,
		workspace,
		sessionId
	]);
	const request = facts.reviewRequest;
	useEffect(() => {
		if (request) setSelected(request.ref);
	}, [request]);
	const own = useMemo(() => {
		const first = links[0]?.snapshot?.ref ?? links[0]?.ref ?? checkout?.[0]?.ref;
		return first ? {
			provider: first.provider,
			host: first.host,
			repository: first.repository
		} : null;
	}, [links, checkout]);
	if (!store) return /* @__PURE__ */ jsx("p", {
		className: "p-3 font-secondary text-fr-sm text-fr-text-3",
		children: "No store on this mount — the viewer needs the host's facts."
	});
	const selectedLink = selected ? links.find((link) => refKey(link.ref) === refKey(selected)) : void 0;
	const selectedSummary = selected ? selectedLink?.snapshot ?? checkout?.find((row) => refKey(row.ref) === refKey(selected)) ?? null : null;
	if (selected && workspace && workspaceDriver) return /* @__PURE__ */ jsx(DetailView, {
		ref: selected,
		summary: selectedSummary,
		link: selectedLink,
		workspace,
		driver: workspaceDriver,
		act,
		onBack: links.length + others.length > 1 || !selectedLink ? () => setSelected(null) : null
	});
	const rowMenu = (ref, url, link) => /* @__PURE__ */ jsx(RowMenu, { actions: [
		{
			label: "Open on the host",
			onClick: () => act("openReview", {
				ref,
				url
			})
		},
		{
			label: "Refresh",
			onClick: () => act("refreshReviews", { ref })
		},
		link ? {
			label: link.source === "stack" ? "Dismiss from session" : "Unlink from session",
			onClick: () => act("unlinkReview", { ref })
		} : {
			label: "Link to this session",
			onClick: () => act("linkReview", {
				ref,
				url
			})
		}
	] });
	return /* @__PURE__ */ jsxs("div", {
		className: "flex min-h-0 flex-1 flex-col",
		children: [
			linking ? /* @__PURE__ */ jsx(LinkDialog, {
				own,
				onClose: () => setLinking(false),
				onSubmit: (ref, url) => {
					act("linkReview", {
						ref,
						url
					});
					setLinking(false);
				}
			}) : null,
			/* @__PURE__ */ jsxs("div", {
				className: "min-h-0 flex-1 overflow-y-auto py-1",
				children: [lines.length === 0 ? /* @__PURE__ */ jsxs("div", {
					className: "flex flex-col items-start gap-2 p-3",
					children: [/* @__PURE__ */ jsx("span", {
						className: "font-secondary text-fr-sm text-fr-text-3",
						children: "No reviews linked to this session yet."
					}), /* @__PURE__ */ jsxs(Button, {
						size: "sm",
						variant: "outline",
						onClick: () => setLinking(true),
						children: [/* @__PURE__ */ jsx(Icon, {
							name: "plus",
							size: 12
						}), " Link a review"]
					})]
				}) : lines.map((line) => /* @__PURE__ */ jsx(ReviewRow, {
					summary: line.link.snapshot,
					link: line.link,
					depth: line.depth,
					stack: line.stack,
					selected: false,
					onSelect: () => setSelected(line.link.ref),
					menu: rowMenu(line.link.ref, line.link.url, line.link)
				}, refKey(line.link.ref))), others.length > 0 ? /* @__PURE__ */ jsxs(Fragment, { children: [/* @__PURE__ */ jsx("div", {
					className: "px-2 pt-2 pb-1 font-secondary text-fr-2xs text-fr-text-3 uppercase",
					children: "Also in this checkout"
				}), others.map((row) => /* @__PURE__ */ jsx(ReviewRow, {
					summary: row,
					depth: 0,
					stack: null,
					selected: false,
					onSelect: () => setSelected(row.ref),
					menu: rowMenu(row.ref, row.url, void 0)
				}, refKey(row.ref)))] }) : null]
			}),
			/* @__PURE__ */ jsxs("footer", {
				className: "flex items-center justify-between border-fr-border border-t px-2 py-1 font-secondary text-fr-2xs text-fr-text-3",
				children: [/* @__PURE__ */ jsx("span", { children: footerLine(links) }), /* @__PURE__ */ jsxs(Button, {
					size: "sm",
					variant: "ghost",
					onClick: () => setLinking(true),
					children: [/* @__PURE__ */ jsx(Icon, {
						name: "plus",
						size: 12
					}), " Link"]
				})]
			})
		]
	});
}
//#endregion
export { PrViewer, PrViewer as default, footerLine, parseLinkInput, refKey, relativeTime };

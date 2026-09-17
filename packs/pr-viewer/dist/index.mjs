import { Badge, Button, ChainRow, ConfirmDialog, DiffStat, GitHubPullRequestIcon, Icon, Input, REVIEW_PILL_LABEL, StateGlyph, StreamingMarkdown, ThreadCard, cn, resolveReviewChains, reviewListLines, reviewPillState, useObservable, useStandardSessionFacts, visibleReviews } from "@fraym/ui";
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
	if (seconds < 45) return "now";
	const minutes = Math.round(seconds / 60);
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.round(minutes / 60);
	if (hours < 24) return `${hours}h`;
	return `${Math.round(hours / 24)}d`;
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
	const state = reviewPillState(summary);
	return {
		tone: state === "merged" ? "accent" : state === "closed" ? "negative" : state === "draft" ? "muted" : state === "conflicting" ? "warning" : "positive",
		icon: "branch",
		label: REVIEW_PILL_LABEL[state]
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
/** A list row is STACKED (owner ruling 2026-09-17): the review's number line
*  on top — state octicon, `#N`, then time and check/decision badges at the
*  right edge — the title full-width beneath it, and the branch + diff stat
*  under that. Every line starts on the same left edge. */
function ReviewRow({ summary, link, depth, stack, sharedBase, sharedOwner, onSelect, menu }) {
	const glyph = stateGlyph(summary);
	const ref = summary?.ref ?? link?.ref;
	const state = summary ? reviewPillState(summary) : "open";
	return /* @__PURE__ */ jsxs(ChainRow, {
		depth,
		className: "group rounded-md pr-3 hover:bg-fr-surface",
		children: [/* @__PURE__ */ jsxs("button", {
			type: "button",
			onClick: onSelect,
			className: "flex min-w-0 flex-1 flex-col gap-1.5 py-2.5 text-left",
			children: [
				/* @__PURE__ */ jsxs("span", {
					className: "flex min-w-0 flex-wrap items-center gap-1.5",
					children: [
						/* @__PURE__ */ jsxs(Badge, {
							variant: "soft",
							tone: state === "merged" ? "accent" : state === "closed" ? "del" : state === "draft" ? "mute" : state === "conflicting" ? "warn" : "add",
							className: "gap-1 rounded-full normal-case tabular-nums",
							title: link ? sourceLabel(link.source) : void 0,
							children: [
								/* @__PURE__ */ jsx(GitHubPullRequestIcon, {
									state,
									size: 12
								}),
								"#",
								ref?.number,
								/* @__PURE__ */ jsxs("span", {
									className: "opacity-80",
									children: ["· ", glyph.label]
								})
							]
						}),
						summary?.reviewDecision === "changes-requested" ? /* @__PURE__ */ jsx(Badge, {
							variant: "soft",
							tone: "warn",
							className: "rounded-full normal-case",
							children: "Changes requested"
						}) : null,
						checksGlyph(summary?.checksState),
						stack ? /* @__PURE__ */ jsxs(Badge, {
							variant: "code",
							tone: "mute",
							className: "gap-1 rounded-full",
							title: stack.kind === "native" ? `Host stack of ${stack.size}: merging a layer lands the ones below it` : `${stack.size} reviews chained by base branch`,
							children: [/* @__PURE__ */ jsx(Icon, {
								name: stack.kind === "native" ? "layers" : "branch",
								size: 12,
								strokeWidth: 1.6
							}), stack.size]
						}) : null,
						summary ? /* @__PURE__ */ jsxs(Badge, {
							variant: "code",
							tone: "mute",
							className: "ml-auto gap-1 rounded-full tabular-nums",
							children: [/* @__PURE__ */ jsx(Icon, {
								name: "clock",
								size: 12,
								strokeWidth: 1.6
							}), relativeTime(summary.updatedAt)]
						}) : null
					]
				}),
				/* @__PURE__ */ jsx("span", {
					className: "line-clamp-2 min-w-0 whitespace-normal break-words text-fr-md font-medium text-fr-text",
					children: summary?.title ?? link?.url ?? ""
				}),
				/* @__PURE__ */ jsxs("span", {
					className: "flex min-w-0 items-center gap-1.5",
					children: [
						summary?.author && summary.author.login !== sharedOwner ? /* @__PURE__ */ jsxs(Badge, {
							variant: "code",
							tone: "mute",
							className: "gap-1 rounded-full",
							children: [/* @__PURE__ */ jsx(Icon, {
								name: "user",
								size: 12,
								strokeWidth: 1.6
							}), summary.author.login]
						}) : null,
						/* @__PURE__ */ jsxs(Badge, {
							variant: "soft",
							tone: "accent",
							className: "min-w-0 max-w-full justify-start gap-1 rounded-full",
							children: [/* @__PURE__ */ jsx(Icon, {
								name: "git-branch",
								size: 12,
								strokeWidth: 1.6
							}), /* @__PURE__ */ jsx("span", {
								className: "truncate",
								children: summary ? summary.baseBranch === sharedBase ? summary.headBranch : `${summary.headBranch} → ${summary.baseBranch}` : ref ? `${ref.host}/${ref.repository}` : ""
							})]
						}),
						summary && (summary.additions !== void 0 || summary.deletions !== void 0) ? /* @__PURE__ */ jsx(Badge, {
							variant: "code",
							tone: "mute",
							className: "ml-auto rounded-full",
							children: /* @__PURE__ */ jsx(DiffStat, {
								className: "text-fr-2xs",
								additions: summary.additions,
								deletions: summary.deletions
							})
						}) : null
					]
				})
			]
		}), /* @__PURE__ */ jsx("span", {
			className: "opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100",
			children: menu
		})]
	});
}
/** The " · " between two facts on one line. */
function LayerGlyph({ state, isDraft }) {
	return /* @__PURE__ */ jsx(StateGlyph, {
		...stateGlyph({
			state,
			isDraft
		}),
		icon: /* @__PURE__ */ jsx(GitHubPullRequestIcon, { size: 11 })
	});
}
function RowMenu({ actions }) {
	const [open, setOpen] = useState(false);
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
				className: "text-fr-2xs text-fr-warn",
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
	const [pending, setPending] = useState(null);
	const threads = useRead(driver.getReviewThreads ? readThreads : null, `${key}:threads`);
	const diff = useRead(tab === "diff" && driver.getReviewDiff ? readDiff : null, `${key}:diff`);
	const [folded, setFolded] = useState({});
	const head = detail.value ?? summary;
	const stack = detail.value?.stack ?? link?.stack ?? null;
	const canMerge = head?.state === "open" && !head.isDraft && (detail.value?.viewer.merge ?? false) && (head.capabilities.merge ?? false);
	const stackHeads = stack?.layers.filter((layer) => layer.state === "open" && layer.headSha).map((layer) => ({
		number: layer.number,
		headSha: layer.headSha
	})) ?? [];
	const stackLayersBelow = stack ? stack.layers.slice(0, stack.layers.findIndex((layer) => layer.number === ref.number) + 1).filter((layer) => layer.state !== "merged") : [];
	const canStackMerge = canMerge && stack !== null && head?.capabilities.stackActions === true && stackLayersBelow.length > 1 && stackLayersBelow.every((layer) => layer.headSha && !layer.isDraft);
	const canStackRebase = stack !== null && head?.capabilities.stackActions === true && (detail.value?.viewer.stackRebase ?? false) && stackHeads.length > 0;
	const conflicting = head?.state === "open" && head.mergeability === "conflicting";
	const glyphInk = head?.state === "merged" ? "text-fr-accent" : head?.state === "closed" ? "text-fr-del" : head?.isDraft ? "text-fr-text-3" : "text-fr-add";
	const statusLabel = head?.state === "merged" ? "Merged" : head?.state === "closed" ? "Closed" : head?.isDraft ? "Draft" : head?.reviewDecision === "approved" ? "Approved" : head?.reviewDecision === "changes-requested" ? "Changes requested" : "Ready for review";
	const statusTone = head?.state === "merged" ? "accent" : head?.state === "closed" ? "del" : head?.isDraft ? "mute" : head?.reviewDecision === "approved" ? "add" : head?.reviewDecision === "changes-requested" ? "warn" : "add";
	const mergeBlocker = head?.state !== "open" ? null : head.isDraft ? "Draft — mark ready for review first" : conflicting ? `Conflicts with ${head.baseBranch} — resolve them first` : detail.value && !detail.value.viewer.merge ? "You cannot merge this review on the host" : null;
	const checksLabel = head?.checksState === "passing" ? "All checks passed" : head?.checksState === "failing" ? "Some checks failed" : head?.checksState === "pending" ? "Checks running" : "None";
	const checksTone = head?.checksState === "passing" ? "positive" : head?.checksState === "failing" ? "negative" : head?.checksState === "pending" ? "warning" : "neutral";
	const reviewers = detail.value?.reviewers.map((r) => r.login) ?? [];
	const openThreads = threads.value?.filter((thread) => !thread.isResolved).length;
	const emptyFacets = [
		...detail.value && reviewers.length === 0 ? ["No reviewers"] : [],
		...threads.value && !threads.value.some((thread) => !thread.isResolved) ? ["no open threads"] : [],
		...head && !head.checksState ? ["no checks"] : []
	];
	return /* @__PURE__ */ jsxs("div", {
		className: "flex min-h-0 min-w-0 flex-1 flex-col",
		children: [
			/* @__PURE__ */ jsxs("header", {
				className: "flex min-w-0 items-center gap-1.5 overflow-hidden border-fr-border-soft border-b px-3 py-1.5",
				children: [
					onBack ? /* @__PURE__ */ jsx(Button, {
						size: "icon",
						variant: "ghost",
						className: "-ml-2.5",
						"aria-label": "Back to this session's reviews",
						onClick: onBack,
						children: /* @__PURE__ */ jsx(Icon, {
							name: "back",
							size: 13
						})
					}) : null,
					/* @__PURE__ */ jsxs("span", {
						className: "flex items-center gap-1.5 text-fr-sm text-fr-text-2 tabular-nums",
						children: [/* @__PURE__ */ jsx(GitHubPullRequestIcon, {
							size: 13,
							className: glyphInk
						}), /* @__PURE__ */ jsxs("span", { children: ["#", ref.number] })]
					}),
					/* @__PURE__ */ jsx("span", { className: "flex-1" }),
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
					}),
					head?.state === "open" ? /* @__PURE__ */ jsx(Button, {
						size: "sm",
						variant: "ghost",
						className: "hover:border-fr-del hover:text-fr-del",
						onClick: () => setPending({
							title: `Close #${ref.number} without merging?`,
							description: `The review closes on ${ref.host}. Its branch stays; you can reopen it from here.`,
							confirmLabel: "Close review",
							intent: "danger",
							input: {
								ref,
								action: "close"
							}
						}),
						children: "Close"
					}) : null,
					canMerge && !canStackMerge ? /* @__PURE__ */ jsx(Button, {
						size: "sm",
						title: `Merge (${detail.value?.allowedMergeMethods[0] ?? "merge"})`,
						onClick: () => setPending({
							title: `Merge #${ref.number}?`,
							description: `${head?.headBranch ?? "This branch"} lands on ${head?.baseBranch ?? "its base"} via ${detail.value?.allowedMergeMethods[0] ?? "merge"} on ${ref.host}. This cannot be undone from here.`,
							confirmLabel: "Merge",
							intent: "default",
							input: {
								ref,
								action: "merge",
								mergeMethod: detail.value?.allowedMergeMethods[0]
							}
						}),
						children: "Merge"
					}) : head?.state === "open" && !head.isDraft && mergeBlocker ? /* @__PURE__ */ jsx(Button, {
						size: "sm",
						variant: "outline",
						disabled: true,
						className: "cursor-not-allowed border-transparent bg-fr-accent-dim text-fr-text-2 disabled:opacity-100",
						"aria-describedby": "pr-viewer-merge-blocker",
						children: "Merge"
					}) : head?.state === "open" && head.isDraft && head.capabilities.draft ? /* @__PURE__ */ jsx(Button, {
						size: "sm",
						variant: "outline",
						onClick: () => act("reviewAction", {
							ref,
							action: "ready"
						}),
						children: "Ready for review"
					}) : head?.state === "closed" ? /* @__PURE__ */ jsx(Button, {
						size: "sm",
						variant: "outline",
						onClick: () => act("reviewAction", {
							ref,
							action: "reopen"
						}),
						children: "Reopen"
					}) : null
				]
			}),
			/* @__PURE__ */ jsx("nav", {
				className: "flex gap-0.5 border-fr-border border-b px-3 py-1.5 text-fr-sm",
				children: [
					"summary",
					"threads",
					"diff"
				].map((name, index) => /* @__PURE__ */ jsx("button", {
					type: "button",
					onClick: () => setTab(name),
					className: cn("rounded-sm px-2 py-0.5 capitalize transition-colors", index === 0 && "-ml-2", tab === name ? "bg-fr-accent-dim text-fr-text" : "text-fr-text-2 hover:bg-fr-surface hover:text-fr-text"),
					children: name
				}, name))
			}),
			/* @__PURE__ */ jsxs("div", {
				className: "min-h-0 min-w-0 flex-1 overflow-y-auto overflow-x-hidden",
				children: [
					detail.error ? /* @__PURE__ */ jsx("p", {
						className: "p-3 text-fr-del text-fr-sm",
						children: detail.error
					}) : null,
					tab === "summary" ? /* @__PURE__ */ jsxs("div", {
						className: "flex flex-col gap-4 p-3",
						children: [
							/* @__PURE__ */ jsxs("div", {
								className: "flex flex-col gap-1",
								children: [/* @__PURE__ */ jsx("h1", {
									className: "font-primary text-fr-xl font-semibold leading-tight tracking-[-0.01em] text-fr-text",
									children: head?.title ?? `#${ref.number}`
								}), /* @__PURE__ */ jsxs("span", {
									className: "flex flex-wrap items-center gap-1.5",
									children: [
										head?.author ? /* @__PURE__ */ jsxs(Badge, {
											variant: "code",
											tone: "mute",
											className: "gap-1 rounded-full pl-1",
											children: [/* @__PURE__ */ jsx("span", {
												"aria-hidden": "true",
												className: "inline-flex size-3.5 items-center justify-center rounded-full bg-fr-surface-3 text-[9px] uppercase text-fr-text",
												children: head.author.login.slice(0, 1)
											}), head.author.login]
										}) : null,
										head?.updatedAt ? /* @__PURE__ */ jsxs(Badge, {
											variant: "code",
											tone: "mute",
											className: "gap-1 rounded-full tabular-nums",
											children: [/* @__PURE__ */ jsx(Icon, {
												name: "clock",
												size: 12,
												strokeWidth: 1.6
											}), relativeTime(head.updatedAt)]
										}) : null,
										/* @__PURE__ */ jsx(Badge, {
											variant: "soft",
											tone: conflicting && statusTone === "add" ? "mute" : statusTone,
											className: "rounded-full normal-case",
											children: statusLabel
										}),
										conflicting ? /* @__PURE__ */ jsxs(Badge, {
											id: "pr-viewer-merge-blocker",
											variant: "soft",
											tone: "warn",
											className: "gap-1 rounded-full normal-case",
											children: [
												/* @__PURE__ */ jsx(Icon, {
													name: "warnTri",
													size: 12,
													strokeWidth: 1.6,
													"aria-hidden": "true"
												}),
												" Conflicts with ",
												head?.baseBranch
											]
										}) : null
									]
								})]
							}),
							/* @__PURE__ */ jsxs("div", {
								className: "flex flex-col gap-1.5",
								children: [
									/* @__PURE__ */ jsxs("span", {
										className: "flex min-w-0 items-center gap-1.5",
										children: [/* @__PURE__ */ jsxs(Badge, {
											variant: "soft",
											tone: "accent",
											className: "min-w-0 max-w-full justify-start gap-1 rounded-full",
											title: `${head?.headBranch ?? "—"} → ${head?.baseBranch ?? "—"}`,
											children: [
												/* @__PURE__ */ jsx(Icon, {
													name: "git-branch",
													size: 12,
													strokeWidth: 1.6
												}),
												/* @__PURE__ */ jsx("span", {
													className: "truncate",
													children: head?.headBranch ?? "—"
												}),
												/* @__PURE__ */ jsxs("span", {
													className: "opacity-70",
													children: ["→ ", head?.baseBranch ?? "—"]
												})
											]
										}), head && (head.additions !== void 0 || head.deletions !== void 0) ? /* @__PURE__ */ jsx(Badge, {
											variant: "code",
											tone: "mute",
											className: "ml-auto rounded-full",
											children: /* @__PURE__ */ jsx(DiffStat, {
												className: "text-fr-2xs",
												additions: head.additions,
												deletions: head.deletions
											})
										}) : null]
									}),
									/* @__PURE__ */ jsxs("span", {
										className: "flex flex-wrap items-center gap-1.5",
										children: [
											reviewers.length > 0 ? /* @__PURE__ */ jsxs(Badge, {
												variant: "code",
												tone: "mute",
												className: "min-w-0 gap-1 rounded-full",
												children: [/* @__PURE__ */ jsx(Icon, {
													name: "user",
													size: 12,
													strokeWidth: 1.6
												}), /* @__PURE__ */ jsx("span", {
													className: "truncate",
													children: reviewers.join(", ")
												})]
											}) : null,
											openThreads ? /* @__PURE__ */ jsxs(Badge, {
												variant: "code",
												tone: "mute",
												className: "gap-1 rounded-full",
												children: [
													/* @__PURE__ */ jsx(Icon, {
														name: "chat",
														size: 12,
														strokeWidth: 1.6
													}),
													openThreads,
													" open"
												]
											}) : null,
											head?.checksState ? /* @__PURE__ */ jsxs(Badge, {
												variant: "soft",
												tone: checksTone === "positive" ? "add" : checksTone === "negative" ? "del" : "warn",
												className: "gap-1 rounded-full normal-case",
												children: [/* @__PURE__ */ jsx(Icon, {
													name: head.checksState === "failing" ? "x" : head.checksState === "pending" ? "clock" : "check",
													size: 12,
													strokeWidth: 1.6
												}), checksLabel]
											}) : null,
											detail.value?.labels.map((label) => /* @__PURE__ */ jsxs(Badge, {
												variant: "code",
												tone: "mute",
												className: "gap-1 rounded-full",
												children: [/* @__PURE__ */ jsx(Icon, {
													name: "pin",
													size: 12,
													strokeWidth: 1.6
												}), label.name]
											}, label.name))
										]
									}),
									emptyFacets.length > 0 ? /* @__PURE__ */ jsx("span", {
										className: "text-fr-xs text-fr-text-2",
										children: emptyFacets.join(" · ")
									}) : null
								]
							}),
							stack ? /* @__PURE__ */ jsxs("section", {
								className: "flex flex-col gap-1 rounded-md border border-fr-border bg-fr-surface p-2",
								children: [
									/* @__PURE__ */ jsxs("span", {
										className: "text-fr-sm font-semibold text-fr-text",
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
											/* @__PURE__ */ jsx(LayerGlyph, {
												state: layer.state,
												isDraft: layer.isDraft ?? false
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
									canStackMerge || canStackRebase ? /* @__PURE__ */ jsxs("span", {
										className: "flex gap-1 pt-1",
										children: [canStackMerge ? /* @__PURE__ */ jsxs(Button, {
											size: "sm",
											onClick: () => setPending({
												title: `Merge the stack under #${ref.number}?`,
												description: `${stackLayersBelow.length} reviews land on ${ref.host} in order, bottom first. This cannot be undone from here.`,
												confirmLabel: `Merge ${stackLayersBelow.length}`,
												intent: "default",
												input: {
													ref,
													action: "merge",
													stackNumber: stack.number,
													expectedStackHeads: stackLayersBelow.map((layer) => ({
														number: layer.number,
														headSha: layer.headSha
													}))
												}
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
									}) : null
								]
							}) : null,
							detail.value ? /* @__PURE__ */ jsxs("section", {
								className: "flex flex-col gap-2",
								children: [
									/* @__PURE__ */ jsx("span", {
										"aria-hidden": "true",
										className: "border-fr-border-soft border-t"
									}),
									detail.value.body.trim() ? /* @__PURE__ */ jsx(StreamingMarkdown, {
										text: detail.value.body,
										className: "text-fr-sm text-fr-text"
									}) : /* @__PURE__ */ jsx("span", {
										className: "text-fr-sm text-fr-text-3",
										children: "No description."
									}),
									detail.value.checks.length > 0 ? /* @__PURE__ */ jsx("ul", {
										className: "mt-2 flex flex-col gap-0.5 rounded-md border border-fr-border bg-fr-surface p-2 text-fr-xs",
										children: detail.value.checks.map((check) => /* @__PURE__ */ jsxs("li", {
											className: "flex items-center gap-2",
											children: [/* @__PURE__ */ jsx("span", {
												className: cn("w-14 shrink-0 tabular-nums", check.status === "success" ? "text-fr-add" : check.status === "failure" ? "text-fr-del" : "text-fr-text-3"),
												children: check.status
											}), /* @__PURE__ */ jsx("span", {
												className: "min-w-0 truncate text-fr-text-2",
												children: check.name
											})]
										}, check.name))
									}) : null
								]
							}) : detail.loading ? /* @__PURE__ */ jsx("span", {
								className: "text-fr-xs text-fr-text-3",
								children: "Loading…"
							}) : null
						]
					}) : null,
					tab === "threads" ? /* @__PURE__ */ jsxs("div", {
						className: "flex flex-col gap-2 p-3",
						children: [
							threads.loading ? /* @__PURE__ */ jsx("span", {
								className: "text-fr-xs text-fr-text-3",
								children: "Loading…"
							}) : null,
							threads.error ? /* @__PURE__ */ jsx("p", {
								className: "text-fr-del text-fr-sm",
								children: threads.error
							}) : null,
							threads.value && threads.value.length > 0 ? /* @__PURE__ */ jsxs("span", {
								className: "text-fr-2xs text-fr-text-3",
								children: [
									threads.value.filter((thread) => !thread.isResolved).length,
									" open · ",
									threads.value.filter((thread) => thread.isResolved).length,
									" resolved"
								]
							}) : null,
							(threads.value ?? []).map((thread) => /* @__PURE__ */ jsxs("div", {
								className: "flex flex-col gap-1",
								children: [/* @__PURE__ */ jsxs("span", {
									className: "flex items-center gap-1.5 text-fr-2xs text-fr-text-3",
									children: [
										/* @__PURE__ */ jsx(Icon, {
											name: "file",
											size: 11,
											"aria-hidden": "true"
										}),
										/* @__PURE__ */ jsx("span", {
											className: "min-w-0 truncate text-fr-text-2",
											children: thread.path ? `${thread.path}${thread.line ? `:${thread.line}` : ""}` : "no longer on a line"
										}),
										thread.isResolved ? /* @__PURE__ */ jsx("span", {
											className: "rounded-[3px] border border-fr-border px-1 text-fr-text-3",
											children: "resolved"
										}) : null,
										thread.isOutdated ? /* @__PURE__ */ jsx("span", {
											className: "rounded-[3px] border border-fr-border px-1 text-fr-text-3",
											children: "outdated"
										}) : null
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
								className: "text-fr-xs text-fr-text-3",
								children: "No review conversations."
							}) : null
						]
					}) : null,
					tab === "diff" ? /* @__PURE__ */ jsxs("div", {
						className: "flex flex-col gap-2 p-3",
						children: [
							diff.loading ? /* @__PURE__ */ jsx("span", {
								className: "text-fr-xs text-fr-text-3",
								children: "Loading…"
							}) : null,
							diff.error ? /* @__PURE__ */ jsx("p", {
								className: "text-fr-del text-fr-sm",
								children: diff.error
							}) : null,
							diff.value && diff.value.files.length > 0 ? /* @__PURE__ */ jsxs("span", {
								className: "flex items-center gap-2 text-fr-2xs text-fr-text-3",
								children: [/* @__PURE__ */ jsxs("span", { children: [
									diff.value.files.length,
									" file",
									diff.value.files.length === 1 ? "" : "s",
									" changed"
								] }), /* @__PURE__ */ jsx(DiffStat, {
									additions: diff.value.files.reduce((sum, file) => sum + file.additions, 0),
									deletions: diff.value.files.reduce((sum, file) => sum + file.deletions, 0)
								})]
							}) : null,
							(diff.value?.files ?? []).map((file) => /* @__PURE__ */ jsxs("details", {
								className: "group rounded-md border border-fr-border bg-fr-surface",
								open: diff.value !== null && diff.value.files.length <= 3,
								children: [/* @__PURE__ */ jsxs("summary", {
									className: "flex cursor-pointer list-none items-center gap-2 px-3 py-1.5 text-fr-xs hover:bg-fr-surface-2",
									children: [
										/* @__PURE__ */ jsx(Icon, {
											name: "file",
											size: 12,
											"aria-hidden": "true"
										}),
										/* @__PURE__ */ jsx("span", {
											className: "min-w-0 flex-1 truncate text-fr-text",
											children: file.path
										}),
										/* @__PURE__ */ jsx(DiffStat, {
											additions: file.additions,
											deletions: file.deletions
										})
									]
								}), file.patch ? /* @__PURE__ */ jsx("div", {
									className: "border-fr-border-soft border-t",
									children: /* @__PURE__ */ jsx(StreamingMarkdown, {
										text: `\`\`\`diff\n${file.patch}\n\`\`\``,
										className: "text-fr-2xs"
									})
								}) : /* @__PURE__ */ jsx("span", {
									className: "block border-fr-border-soft border-t px-3 py-1.5 text-fr-2xs text-fr-text-2",
									children: "Hunks withheld by the host."
								})]
							}, file.path)),
							diff.value && diff.value.files.length === 0 ? /* @__PURE__ */ jsx("span", {
								className: "text-fr-xs text-fr-text-3",
								children: "No file changes."
							}) : null,
							diff.value?.truncated ? /* @__PURE__ */ jsx("span", {
								className: "text-fr-2xs text-fr-text-3",
								children: "More files than the host returned — open on the host for the rest."
							}) : null
						]
					}) : null
				]
			}),
			pending ? /* @__PURE__ */ jsx(ConfirmDialog, {
				title: pending.title,
				description: pending.description,
				confirmLabel: pending.confirmLabel,
				intent: pending.intent,
				icon: pending.intent === "danger" ? "x" : "git-pr",
				onConfirm: () => {
					act("reviewAction", pending.input);
					setPending(null);
				},
				onClose: () => setPending(null)
			}) : null
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
		className: "p-3 text-fr-sm text-fr-text-3",
		children: "No store on this mount — the viewer needs the host's facts."
	});
	const selectedLink = selected ? links.find((link) => refKey(link.ref) === refKey(selected)) : void 0;
	const summaryFor = (link) => link.snapshot ?? checkout?.find((row) => refKey(row.ref) === refKey(link.ref)) ?? null;
	const sharedBase = useMemo(() => {
		const bases = /* @__PURE__ */ new Set();
		for (const line of lines) {
			const base = summaryFor(line.link)?.baseBranch;
			if (base) bases.add(base);
		}
		for (const row of others) bases.add(row.baseBranch);
		return bases.size === 1 ? [...bases][0] : null;
	}, [
		lines,
		others,
		summaryFor
	]);
	const sharedOwner = useMemo(() => {
		const owners = /* @__PURE__ */ new Set();
		for (const line of lines) {
			const owner = summaryFor(line.link)?.author?.login;
			if (owner) owners.add(owner);
		}
		for (const row of others) if (row.author) owners.add(row.author.login);
		return owners.size === 1 ? [...owners][0] : null;
	}, [
		lines,
		others,
		summaryFor
	]);
	const selectedSummary = selected ? selectedLink ? summaryFor(selectedLink) : checkout?.find((row) => refKey(row.ref) === refKey(selected)) ?? null : null;
	if (selected && workspace && workspaceDriver) return /* @__PURE__ */ jsx(DetailView, {
		ref: selected,
		summary: selectedSummary,
		link: selectedLink,
		workspace,
		driver: workspaceDriver,
		act,
		onBack: links.length + others.length > 1 || !selectedLink ? () => setSelected(null) : null
	});
	const rowMenu = (ref, url, link, summary) => /* @__PURE__ */ jsx(RowMenu, { actions: [
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
		...sessionId ? [link ? {
			label: link.source === "stack" ? "Dismiss from session" : "Unlink from session",
			onClick: () => act("unlinkReview", { ref })
		} : {
			label: "Link to this session",
			onClick: () => act("linkReview", {
				ref,
				url,
				...summary ? { snapshot: summary } : {}
			})
		}] : []
	] });
	return /* @__PURE__ */ jsxs("div", {
		className: "flex min-h-0 min-w-0 flex-1 flex-col",
		children: [
			linking ? /* @__PURE__ */ jsx(LinkDialog, {
				own,
				onClose: () => setLinking(false),
				onSubmit: (ref, url) => {
					const known = checkout?.find((row) => refKey(row.ref) === refKey(ref));
					act("linkReview", {
						ref,
						url,
						...known ? { snapshot: known } : {}
					});
					setLinking(false);
				}
			}) : null,
			/* @__PURE__ */ jsxs("div", {
				className: "min-h-0 flex-1 overflow-y-auto px-2 py-2",
				children: [lines.length === 0 ? /* @__PURE__ */ jsxs("div", {
					className: "flex flex-col items-start gap-2 p-3",
					children: [/* @__PURE__ */ jsx("span", {
						className: "text-fr-sm text-fr-text-3",
						children: sessionId ? "No reviews linked to this session yet." : "Start a session to link reviews to it."
					}), sessionId ? /* @__PURE__ */ jsxs(Button, {
						size: "sm",
						variant: "outline",
						onClick: () => setLinking(true),
						children: [/* @__PURE__ */ jsx(Icon, {
							name: "plus",
							size: 12
						}), " Link a review"]
					}) : null]
				}) : /* @__PURE__ */ jsxs(Fragment, { children: [others.length > 0 ? /* @__PURE__ */ jsx("div", {
					className: "px-2 pt-2 pb-2 text-fr-sm font-semibold text-fr-text",
					children: "Linked to this session"
				}) : null, lines.map((line) => /* @__PURE__ */ jsx(ReviewRow, {
					summary: summaryFor(line.link),
					link: line.link,
					depth: line.depth,
					stack: line.stack,
					sharedBase,
					sharedOwner,
					onSelect: () => setSelected(line.link.ref),
					menu: rowMenu(line.link.ref, line.link.url, line.link)
				}, refKey(line.link.ref)))] }), others.length > 0 ? /* @__PURE__ */ jsxs(Fragment, { children: [/* @__PURE__ */ jsx("div", {
					className: "px-2 pt-5 pb-2 text-fr-sm font-semibold text-fr-text",
					children: "Also in this checkout"
				}), others.map((row) => /* @__PURE__ */ jsx(ReviewRow, {
					summary: row,
					depth: 0,
					stack: null,
					sharedBase,
					sharedOwner,
					onSelect: () => setSelected(row.ref),
					menu: rowMenu(row.ref, row.url, void 0, row)
				}, refKey(row.ref)))] }) : null]
			}),
			/* @__PURE__ */ jsxs("footer", {
				className: "flex items-center justify-between border-fr-border border-t px-4 py-2 text-fr-2xs text-fr-text-2",
				children: [/* @__PURE__ */ jsxs("span", {
					className: "truncate",
					children: [footerLine(links), sharedOwner ? ` · by ${sharedOwner}` : ""]
				}), sessionId ? /* @__PURE__ */ jsxs(Button, {
					size: "sm",
					variant: "ghost",
					onClick: () => setLinking(true),
					children: [/* @__PURE__ */ jsx(Icon, {
						name: "plus",
						size: 12
					}), " Link"]
				}) : null]
			})
		]
	});
}
//#endregion
export { PrViewer, PrViewer as default, footerLine, parseLinkInput, refKey, relativeTime };

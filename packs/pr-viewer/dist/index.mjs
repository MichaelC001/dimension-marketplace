import { Button, ChainRow, ConfirmDialog, DiffStat, GitHubPullRequestIcon, Icon, Input, Pill, REVIEW_PILL_LABEL, REVIEW_PILL_TINT, Skeleton, SkeletonGroup, SkeletonText, Spinner, StateGlyph, StreamingMarkdown, Textarea, ThreadCard, cn, resolveReviewChains, reviewListLines, reviewPillState, reviewsUnavailableAdvice, useObservable, useStandardSessionFacts, visibleReviews } from "@fraym/ui";
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
//#region src/compose.tsx
/** Reply into a line thread, or flip its resolution. One field, one send;
*  the settle re-reads the threads so the reply appears where it landed. */
function ThreadWrite({ resolved, onReply, onResolve }) {
	const [body, setBody] = useState("");
	const [open, setOpen] = useState(false);
	return /* @__PURE__ */ jsxs("div", {
		className: "flex flex-col gap-1.5 pl-1",
		"data-slot": "pr-viewer-thread-write",
		children: [open ? /* @__PURE__ */ jsx(Textarea, {
			autoFocus: true,
			value: body,
			rows: 2,
			placeholder: "Reply…",
			onChange: (event) => setBody(event.target.value),
			onKeyDown: (event) => {
				if (event.key === "Escape") setOpen(false);
				if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && body.trim()) {
					onReply(body.trim());
					setBody("");
					setOpen(false);
				}
			}
		}) : null, /* @__PURE__ */ jsxs("span", {
			className: "flex items-center gap-1.5",
			children: [open ? /* @__PURE__ */ jsx(Button, {
				size: "sm",
				disabled: !body.trim(),
				onClick: () => {
					onReply(body.trim());
					setBody("");
					setOpen(false);
				},
				children: "Reply"
			}) : /* @__PURE__ */ jsx(Button, {
				size: "sm",
				variant: "ghost",
				onClick: () => setOpen(true),
				children: "Reply"
			}), /* @__PURE__ */ jsx(Button, {
				size: "sm",
				variant: "ghost",
				onClick: onResolve,
				children: resolved ? "Unresolve" : "Resolve"
			})]
		})]
	});
}
/** The review's own composer: a comment, or a verdict with an optional body.
*  Approve / Request changes confirm nothing — they are the reviewer's word,
*  reversible on the host; Merge and Close stay behind the dialog. */
function ReviewWrite({ verdicts, onComment, onReview }) {
	const [body, setBody] = useState("");
	const send = (fn) => {
		fn();
		setBody("");
	};
	return /* @__PURE__ */ jsxs("div", {
		className: "flex flex-col gap-2 border-fr-border border-t p-3",
		"data-slot": "pr-viewer-review-write",
		children: [/* @__PURE__ */ jsx(Textarea, {
			value: body,
			rows: 3,
			placeholder: "Comment, or say why you approve or want changes…",
			onChange: (event) => setBody(event.target.value),
			onKeyDown: (event) => {
				if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && body.trim()) send(() => onComment(body.trim()));
			}
		}), /* @__PURE__ */ jsxs("span", {
			className: "flex flex-wrap items-center gap-1.5",
			children: [/* @__PURE__ */ jsx(Button, {
				size: "sm",
				variant: "outline",
				disabled: !body.trim(),
				onClick: () => send(() => onComment(body.trim())),
				children: "Comment"
			}), verdicts ? /* @__PURE__ */ jsxs(Fragment, { children: [
				/* @__PURE__ */ jsx("span", { className: "flex-1" }),
				/* @__PURE__ */ jsx(Button, {
					size: "sm",
					variant: "outline",
					disabled: !body.trim(),
					onClick: () => send(() => onReview("request-changes", body.trim())),
					children: "Request changes"
				}),
				/* @__PURE__ */ jsx(Button, {
					size: "sm",
					onClick: () => send(() => onReview("approve", body.trim() || void 0)),
					children: "Approve"
				})
			] }) : null]
		})]
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
//#endregion
//#region src/use-read.ts
/** One request/response read, keyed: detail, threads and the diff are large and
*  on demand, never a cell (doc 73 §3). A new `key` (a new ref, or a settled
*  write) re-reads; `read === null` means this host cannot answer at all.
*
*  Stale-while-revalidate (dimension#902): a re-read over a painted value keeps
*  the old value with `loading: true` so callers can dim it instead of swapping
*  it for a spinner. Only a first-ever read (nothing painted yet) reports
*  `value: null` with `loading: true`. An errored re-read still blanks to `null`
*  so the error surfaces instead of a quietly stale number. */
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
		setState((prev) => ({
			key,
			value: prev.value,
			error: null,
			loading: true
		}));
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
	if (state.key !== key) return {
		value: state.value,
		error: null,
		loading: read !== null
	};
	return state;
}
//#endregion
//#region src/diff-tab.tsx
function DiffTab({ reviewRef, workspace, getReviewDiff, cacheKey }) {
	const diff = useRead(useCallback(() => getReviewDiff(workspace, reviewRef), [
		getReviewDiff,
		workspace,
		reviewRef
	]), cacheKey);
	const files = diff.value?.files ?? [];
	const firstLoad = diff.value === null && diff.loading;
	const stale = diff.value !== null && diff.loading;
	return /* @__PURE__ */ jsxs("div", {
		className: "flex flex-col gap-2 p-3",
		"aria-busy": diff.loading || void 0,
		children: [
			firstLoad ? /* @__PURE__ */ jsxs("div", {
				className: "flex items-center gap-2 text-fr-xs text-fr-text-3",
				"aria-label": "Loading diff",
				children: [/* @__PURE__ */ jsx(Spinner, {
					kind: "dots",
					size: "xs",
					label: "Loading diff"
				}), /* @__PURE__ */ jsx("span", { children: "Loading diff…" })]
			}) : null,
			diff.error ? /* @__PURE__ */ jsx("p", {
				className: "text-fr-del text-fr-sm",
				children: diff.error
			}) : null,
			/* @__PURE__ */ jsxs("div", {
				className: stale ? "flex flex-col gap-2 opacity-60" : "flex flex-col gap-2",
				children: [
					files.length > 0 ? /* @__PURE__ */ jsxs("span", {
						className: "flex items-center gap-2 text-fr-2xs text-fr-text-3",
						children: [/* @__PURE__ */ jsxs("span", { children: [
							files.length,
							" file",
							files.length === 1 ? "" : "s",
							" changed"
						] }), /* @__PURE__ */ jsx(DiffStat, {
							additions: files.reduce((sum, file) => sum + file.additions, 0),
							deletions: files.reduce((sum, file) => sum + file.deletions, 0)
						})]
					}) : null,
					files.map((file) => /* @__PURE__ */ jsxs("details", {
						className: "group rounded-md border border-fr-border bg-fr-surface",
						open: files.length <= 3,
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
					diff.value && diff.value.files.length === 0 && !diff.loading ? /* @__PURE__ */ jsx("span", {
						className: "text-fr-xs text-fr-text-3",
						children: "No file changes."
					}) : null,
					diff.value?.truncated ? /* @__PURE__ */ jsx("span", {
						className: "text-fr-2xs text-fr-text-3",
						children: "More files than the host returned — open on the host for the rest."
					}) : null
				]
			})
		]
	});
}
//#endregion
//#region src/summary-tab.tsx
function SummaryTab({ reviewRef, head, detail, loading, stack, threads, conflicting, stackLayersBelow, canStackMerge, canStackRebase, act, onConfirm }) {
	const statusLabel = head?.state === "merged" ? "Merged" : head?.state === "closed" ? "Closed" : head?.isDraft ? "Draft" : head?.reviewDecision === "approved" ? "Approved" : head?.reviewDecision === "changes-requested" ? "Changes requested" : "Ready for review";
	const statusTint = head?.state === "merged" ? "bg-fr-accent-dim" : head?.state === "closed" ? "bg-fr-del-bg" : head?.reviewDecision === "approved" ? "bg-fr-add-bg" : head?.reviewDecision === "changes-requested" ? "bg-fr-warn/15" : void 0;
	const checksLabel = head?.checksState === "passing" ? "All checks passed" : head?.checksState === "failing" ? "Some checks failed" : head?.checksState === "pending" ? "Checks running" : "None";
	const checksTone = head?.checksState === "passing" ? "positive" : head?.checksState === "failing" ? "negative" : head?.checksState === "pending" ? "warning" : "neutral";
	const reviewers = detail?.reviewers.map((r) => r.login) ?? [];
	const openThreads = threads?.filter((thread) => !thread.isResolved).length;
	const emptyFacets = [
		...detail && reviewers.length === 0 ? ["No reviewers"] : [],
		...threads && !threads.some((thread) => !thread.isResolved) ? ["no open threads"] : [],
		...head && !head.checksState ? ["no checks"] : []
	];
	return /* @__PURE__ */ jsxs("div", {
		className: "flex flex-col gap-4 p-3",
		children: [
			/* @__PURE__ */ jsxs("div", {
				className: "flex flex-col gap-1",
				children: [/* @__PURE__ */ jsx("h1", {
					className: "font-primary text-fr-xl font-semibold leading-tight tracking-[-0.01em] text-fr-text",
					children: head?.title ?? `#${reviewRef.number}`
				}), /* @__PURE__ */ jsxs("span", {
					className: "flex flex-wrap items-center gap-1.5",
					children: [
						head?.author ? /* @__PURE__ */ jsxs(Pill, { children: [/* @__PURE__ */ jsx(Icon, {
							name: "user",
							size: 12,
							strokeWidth: 1.6
						}), head.author.login] }) : null,
						head?.updatedAt ? /* @__PURE__ */ jsxs(Pill, {
							className: "tabular-nums",
							children: [/* @__PURE__ */ jsx(Icon, {
								name: "clock",
								size: 12,
								strokeWidth: 1.6
							}), relativeTime(head.updatedAt)]
						}) : null,
						/* @__PURE__ */ jsx(Pill, {
							tint: conflicting ? void 0 : statusTint,
							children: statusLabel
						}),
						conflicting ? /* @__PURE__ */ jsxs(Pill, {
							id: "pr-viewer-merge-blocker",
							tint: "bg-fr-warn/15",
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
						children: [/* @__PURE__ */ jsxs(Pill, {
							className: "min-w-0 max-w-full justify-start",
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
									className: "text-fr-text-3",
									children: ["→ ", head?.baseBranch ?? "—"]
								})
							]
						}), head && (head.additions !== void 0 || head.deletions !== void 0) ? /* @__PURE__ */ jsx(Pill, {
							className: "ml-auto",
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
							reviewers.length > 0 ? /* @__PURE__ */ jsxs(Pill, {
								className: "min-w-0",
								children: [/* @__PURE__ */ jsx(Icon, {
									name: "user",
									size: 12,
									strokeWidth: 1.6
								}), /* @__PURE__ */ jsx("span", {
									className: "truncate",
									children: reviewers.join(", ")
								})]
							}) : null,
							openThreads ? /* @__PURE__ */ jsxs(Pill, { children: [
								/* @__PURE__ */ jsx(Icon, {
									name: "chat",
									size: 12,
									strokeWidth: 1.6
								}),
								openThreads,
								" open"
							] }) : null,
							head?.checksState ? /* @__PURE__ */ jsxs(Pill, {
								tint: checksTone === "positive" ? "bg-fr-add-bg" : checksTone === "negative" ? "bg-fr-del-bg" : "bg-fr-warn/15",
								children: [/* @__PURE__ */ jsx(Icon, {
									name: head.checksState === "failing" ? "x" : head.checksState === "pending" ? "clock" : "check",
									size: 12,
									strokeWidth: 1.6
								}), checksLabel]
							}) : null,
							detail?.labels.map((label) => /* @__PURE__ */ jsxs(Pill, { children: [/* @__PURE__ */ jsx(Icon, {
								name: "pin",
								size: 12,
								strokeWidth: 1.6
							}), label.name] }, label.name))
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
						className: cn("flex items-center gap-2 text-fr-xs", layer.number === reviewRef.number ? "text-fr-text" : "text-fr-text-2"),
						children: [
							/* @__PURE__ */ jsx(GitHubPullRequestIcon, {
								state: reviewPillState({
									state: layer.state,
									isDraft: layer.isDraft ?? false
								}),
								size: 12
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
							onClick: () => onConfirm({
								title: `Merge the stack under #${reviewRef.number}?`,
								description: `${stackLayersBelow.length} reviews land on ${reviewRef.host} in order, bottom first. This cannot be undone from here.`,
								confirmLabel: `Merge ${stackLayersBelow.length}`,
								intent: "default",
								input: {
									ref: reviewRef,
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
								ref: reviewRef,
								action: "update-branch"
							}),
							children: "Rebase stack"
						}) : null]
					}) : null
				]
			}) : null,
			detail ? /* @__PURE__ */ jsxs("section", {
				className: cn("flex flex-col gap-2", loading && "opacity-60"),
				"aria-busy": loading || void 0,
				children: [
					/* @__PURE__ */ jsx("span", {
						"aria-hidden": "true",
						className: "border-fr-border-soft border-t"
					}),
					detail.body.trim() ? /* @__PURE__ */ jsx(StreamingMarkdown, {
						text: detail.body,
						className: "text-fr-sm text-fr-text"
					}) : /* @__PURE__ */ jsx("span", {
						className: "text-fr-sm text-fr-text-3",
						children: "No description."
					}),
					detail.checks.length > 0 ? /* @__PURE__ */ jsx("ul", {
						className: "mt-2 flex flex-col gap-0.5 rounded-md border border-fr-border bg-fr-surface p-2 text-fr-xs",
						children: detail.checks.map((check) => /* @__PURE__ */ jsxs("li", {
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
			}) : loading ? /* @__PURE__ */ jsxs("section", {
				className: "flex flex-col gap-2",
				"aria-label": "Loading review details",
				children: [
					/* @__PURE__ */ jsx("span", {
						"aria-hidden": "true",
						className: "border-fr-border-soft border-t"
					}),
					/* @__PURE__ */ jsx(SkeletonText, {
						lines: 4,
						lineHeight: 12,
						gap: 8
					}),
					/* @__PURE__ */ jsxs("div", {
						className: "mt-2 flex flex-col gap-2 rounded-md border border-fr-border bg-fr-surface p-2",
						children: [
							/* @__PURE__ */ jsx(Skeleton, {
								h: 10,
								rounded: "sm",
								w: "100%"
							}),
							/* @__PURE__ */ jsx(Skeleton, {
								h: 10,
								rounded: "sm",
								w: "100%"
							}),
							/* @__PURE__ */ jsx(Skeleton, {
								h: 10,
								rounded: "sm",
								w: "70%"
							})
						]
					})
				]
			}) : null
		]
	});
}
//#endregion
//#region src/threads-tab.tsx
function ThreadsTab({ reviewRef, threads, loading, error, canWrite, act }) {
	const [folded, setFolded] = useState({});
	return /* @__PURE__ */ jsxs("div", {
		className: "flex flex-col gap-2 p-3",
		"aria-busy": loading || void 0,
		children: [
			threads === null && loading ? /* @__PURE__ */ jsx(SkeletonGroup, {
				label: "Loading review threads",
				children: /* @__PURE__ */ jsxs("div", {
					className: "flex flex-col gap-3",
					children: [
						/* @__PURE__ */ jsx(Skeleton, {
							h: 10,
							rounded: "sm",
							w: "45%"
						}),
						/* @__PURE__ */ jsx("div", {
							className: "flex flex-col gap-1 rounded-md border border-fr-border bg-fr-surface p-2",
							children: /* @__PURE__ */ jsx(SkeletonText, {
								lines: 3,
								lineHeight: 10,
								gap: 6
							})
						}),
						/* @__PURE__ */ jsx(Skeleton, {
							h: 10,
							rounded: "sm",
							w: "35%"
						}),
						/* @__PURE__ */ jsx("div", {
							className: "flex flex-col gap-1 rounded-md border border-fr-border bg-fr-surface p-2",
							children: /* @__PURE__ */ jsx(SkeletonText, {
								lines: 2,
								lineHeight: 10,
								gap: 6
							})
						})
					]
				})
			}) : null,
			error ? /* @__PURE__ */ jsx("p", {
				className: "text-fr-del text-fr-sm",
				children: error
			}) : null,
			/* @__PURE__ */ jsxs("div", {
				className: loading && threads !== null ? "flex flex-col gap-2 opacity-60" : "flex flex-col gap-2",
				children: [
					threads && threads.length > 0 ? /* @__PURE__ */ jsxs("span", {
						className: "text-fr-2xs text-fr-text-3",
						children: [
							threads.filter((thread) => !thread.isResolved).length,
							" open · ",
							threads.filter((thread) => thread.isResolved).length,
							" resolved"
						]
					}) : null,
					(threads ?? []).map((thread) => /* @__PURE__ */ jsxs("div", {
						className: "flex flex-col gap-1",
						children: [
							/* @__PURE__ */ jsxs("span", {
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
							}),
							/* @__PURE__ */ jsx(ThreadCard, {
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
							}),
							canWrite ? /* @__PURE__ */ jsx(ThreadWrite, {
								resolved: thread.isResolved,
								onReply: (body) => act("reviewAction", {
									ref: reviewRef,
									action: "reply",
									threadId: thread.id,
									body
								}),
								onResolve: () => act("reviewAction", {
									ref: reviewRef,
									action: thread.isResolved ? "unresolve" : "resolve",
									threadId: thread.id
								})
							}) : null
						]
					}, thread.id)),
					threads && threads.length === 0 && !loading ? /* @__PURE__ */ jsx("span", {
						className: "text-fr-xs text-fr-text-3",
						children: "No review conversations."
					}) : null
				]
			})
		]
	});
}
//#endregion
//#region src/detail-view.tsx
function DetailView({ reviewRef, summary, link, workspace, driver, act, onBack, settledActions, actionNotice }) {
	const key = `${refKey(reviewRef)}@${settledActions}`;
	const { getReview, getReviewThreads, getReviewDiff } = driver;
	const detail = useRead(useMemo(() => getReview ? () => getReview(workspace, reviewRef) : null, [
		getReview,
		workspace,
		reviewRef
	]), key);
	const [tab, setTab] = useState("summary");
	const [pending, setPending] = useState(null);
	const head = detail.value ?? summary;
	const hasThreads = getReviewThreads !== void 0 && head?.capabilities.reviewThreads === true;
	const hasDiff = getReviewDiff !== void 0 && head?.capabilities.diff === true;
	const tabs = [
		"summary",
		...hasThreads ? ["threads"] : [],
		...hasDiff ? ["diff"] : []
	];
	const active = tabs.includes(tab) ? tab : "summary";
	const threads = useRead(useMemo(() => getReviewThreads && hasThreads ? () => getReviewThreads(workspace, reviewRef) : null, [
		getReviewThreads,
		hasThreads,
		workspace,
		reviewRef
	]), `${key}:threads`);
	const stack = detail.value?.stack ?? link?.stack ?? null;
	const canMerge = head?.state === "open" && !head.isDraft && (detail.value?.viewer.merge ?? false) && (head.capabilities.merge ?? false);
	const layerIndex = stack ? stack.layers.findIndex((layer) => layer.number === reviewRef.number) : -1;
	const hasOpenLayerAbove = stack !== null && stack.layers.slice(layerIndex + 1).some((layer) => layer.state === "open");
	const stackLayersBelow = stack ? stack.layers.slice(0, layerIndex + 1).filter((layer) => layer.state !== "merged") : [];
	const canStackMerge = canMerge && stack !== null && !hasOpenLayerAbove && head?.capabilities.stackActions === true && stackLayersBelow.length > 1 && stackLayersBelow.every((layer) => layer.headSha && !layer.isDraft);
	const canStackRebase = stack !== null && head?.capabilities.stackActions === true && (detail.value?.viewer.stackRebase ?? false);
	const conflicting = head?.state === "open" && head.mergeability === "conflicting";
	const mergeBlocker = head?.state !== "open" ? null : head.isDraft ? "Draft — mark ready for review first" : conflicting ? `Conflicts with ${head.baseBranch} — resolve them first` : detail.value && !detail.value.viewer.merge ? "You cannot merge this review on the host" : null;
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
							state: head ? reviewPillState(head) : "open",
							size: 12
						}), /* @__PURE__ */ jsxs("span", { children: ["#", reviewRef.number] })]
					}),
					/* @__PURE__ */ jsx("span", { className: "flex-1" }),
					/* @__PURE__ */ jsx(Button, {
						size: "icon",
						variant: "ghost",
						"aria-label": `Open on ${reviewRef.host}`,
						onClick: () => act("openReview", {
							ref: reviewRef,
							url: head?.url ?? link?.url ?? "",
							external: true
						}),
						children: /* @__PURE__ */ jsx(Icon, {
							name: "external",
							size: 13
						})
					}),
					head?.state === "open" ? /* @__PURE__ */ jsxs(Button, {
						size: "sm",
						variant: "destructive",
						onClick: () => setPending({
							title: `Close #${reviewRef.number} without merging?`,
							description: `The review closes on ${reviewRef.host}. Its branch stays; you can reopen it from here.`,
							confirmLabel: `Close ${head.label}`,
							intent: "danger",
							input: {
								ref: reviewRef,
								action: "close"
							}
						}),
						children: ["Close ", head.label]
					}) : null,
					canMerge && !canStackMerge ? /* @__PURE__ */ jsx(Button, {
						size: "sm",
						title: `Merge (${detail.value?.allowedMergeMethods[0] ?? "merge"})`,
						onClick: () => setPending({
							title: `Merge #${reviewRef.number}?`,
							description: `${head?.headBranch ?? "This branch"} lands on ${head?.baseBranch ?? "its base"} via ${detail.value?.allowedMergeMethods[0] ?? "merge"} on ${reviewRef.host}. This cannot be undone from here.`,
							confirmLabel: "Merge",
							intent: "default",
							input: {
								ref: reviewRef,
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
							ref: reviewRef,
							action: "ready"
						}),
						children: "Ready for review"
					}) : head?.state === "closed" ? /* @__PURE__ */ jsx(Button, {
						size: "sm",
						variant: "outline",
						onClick: () => act("reviewAction", {
							ref: reviewRef,
							action: "reopen"
						}),
						children: "Reopen"
					}) : null
				]
			}),
			tabs.length > 1 ? /* @__PURE__ */ jsx("nav", {
				className: "flex gap-0.5 border-fr-border border-b px-3 py-1.5 text-fr-sm",
				children: tabs.map((name, index) => /* @__PURE__ */ jsx("button", {
					type: "button",
					onClick: () => setTab(name),
					className: cn("rounded-sm px-2 py-0.5 capitalize transition-colors", index === 0 && "-ml-2", active === name ? "bg-fr-accent-dim text-fr-text" : "text-fr-text-2 hover:bg-fr-surface hover:text-fr-text"),
					children: name
				}, name))
			}) : null,
			/* @__PURE__ */ jsxs("div", {
				className: "min-h-0 min-w-0 flex-1 overflow-y-auto overflow-x-hidden",
				children: [
					detail.error ? /* @__PURE__ */ jsx("p", {
						className: "p-3 text-fr-del text-fr-sm",
						children: detail.error
					}) : null,
					active === "summary" ? /* @__PURE__ */ jsx(SummaryTab, {
						reviewRef,
						head,
						detail: detail.value,
						loading: detail.loading,
						stack,
						threads: threads.value,
						conflicting,
						stackLayersBelow,
						canStackMerge,
						canStackRebase,
						act,
						onConfirm: setPending
					}) : null,
					active === "threads" ? /* @__PURE__ */ jsx(ThreadsTab, {
						reviewRef,
						threads: threads.value,
						loading: threads.loading,
						error: threads.error,
						canWrite: head?.capabilities.threadReplies === true,
						act
					}) : null,
					active === "diff" && getReviewDiff ? /* @__PURE__ */ jsx(DiffTab, {
						reviewRef,
						workspace,
						getReviewDiff,
						cacheKey: `${key}:diff`
					}) : null
				]
			}),
			actionNotice ? /* @__PURE__ */ jsx("p", {
				className: "border-fr-border border-t px-3 py-2 text-fr-xs text-fr-del",
				"data-slot": "pr-viewer-action-notice",
				children: actionNotice
			}) : null,
			active === "summary" && head?.state === "open" ? /* @__PURE__ */ jsx(ReviewWrite, {
				verdicts: head.capabilities.verdicts === true,
				onComment: (body) => act("reviewAction", {
					ref: reviewRef,
					action: "comment",
					body
				}),
				onReview: (verdict, body) => act("reviewAction", {
					ref: reviewRef,
					action: "submit-review",
					verdict,
					...body ? { body } : {}
				})
			}) : null,
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
//#endregion
//#region src/review-row.tsx
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
*  on top — a fixed state glyph box, `#N`, then time and check/decision
*  badges at the right edge — the title full-width beneath it, and the branch
*  + diff stat under that. Every line starts on the same left edge. The row
*  itself is a `ChainRow` card, so one review reads as one block at rest; the
*  glyph box is the rail hover card's idiom (`size-5`, state tint), giving the
*  status column a fixed x every row scans on. */
function ReviewRow({ summary, link, depth, stack, sharedBase, sharedOwner, onSelect, menu }) {
	const ref = summary?.ref ?? link?.ref;
	const state = summary ? reviewPillState(summary) : "open";
	const label = summary ? REVIEW_PILL_LABEL[state] : "Not synced yet";
	return /* @__PURE__ */ jsxs(ChainRow, {
		depth,
		variant: "card",
		className: "group pr-3",
		children: [/* @__PURE__ */ jsxs("button", {
			type: "button",
			onClick: onSelect,
			className: "flex min-w-0 flex-1 flex-col gap-1 py-2 text-left",
			children: [
				/* @__PURE__ */ jsxs("span", {
					className: "flex min-w-0 flex-wrap items-center gap-1.5",
					children: [
						/* @__PURE__ */ jsx("span", {
							className: cn("inline-flex size-5 shrink-0 items-center justify-center rounded-sm border border-fr-border", REVIEW_PILL_TINT[state]),
							"aria-hidden": true,
							children: /* @__PURE__ */ jsx(GitHubPullRequestIcon, {
								state,
								size: 12
							})
						}),
						/* @__PURE__ */ jsxs(Pill, {
							tint: REVIEW_PILL_TINT[state],
							className: "tabular-nums",
							title: link ? sourceLabel(link.source) : void 0,
							children: [/* @__PURE__ */ jsxs("span", {
								className: "text-fr-text",
								children: ["#", ref?.number]
							}), /* @__PURE__ */ jsxs("span", { children: ["· ", label] })]
						}),
						summary?.reviewDecision === "changes-requested" ? /* @__PURE__ */ jsx(Pill, {
							tint: "bg-fr-warn/15",
							children: "Changes requested"
						}) : null,
						checksGlyph(summary?.checksState),
						stack ? /* @__PURE__ */ jsxs(Pill, {
							title: stack.kind === "native" ? `Host stack of ${stack.size}: merging a layer lands the ones below it` : `${stack.size} reviews chained by base branch`,
							children: [/* @__PURE__ */ jsx(Icon, {
								name: stack.kind === "native" ? "layers" : "branch",
								size: 12,
								strokeWidth: 1.6
							}), stack.size]
						}) : null,
						summary ? /* @__PURE__ */ jsxs(Pill, {
							className: "ml-auto tabular-nums",
							children: [/* @__PURE__ */ jsx(Icon, {
								name: "clock",
								size: 12,
								strokeWidth: 1.6
							}), relativeTime(summary.updatedAt)]
						}) : null
					]
				}),
				/* @__PURE__ */ jsx("span", {
					className: "min-w-0 truncate text-fr-sm font-semibold text-fr-text",
					title: summary?.title ?? link?.url ?? "",
					children: summary?.title ?? link?.url ?? ""
				}),
				/* @__PURE__ */ jsxs("span", {
					className: "flex min-w-0 items-center gap-1.5",
					children: [
						summary?.author && summary.author.login !== sharedOwner ? /* @__PURE__ */ jsxs(Pill, { children: [/* @__PURE__ */ jsx(Icon, {
							name: "user",
							size: 12,
							strokeWidth: 1.6
						}), summary.author.login] }) : null,
						/* @__PURE__ */ jsxs(Pill, {
							className: "min-w-0 max-w-full justify-start",
							children: [/* @__PURE__ */ jsx(Icon, {
								name: "git-branch",
								size: 12,
								strokeWidth: 1.6
							}), /* @__PURE__ */ jsx("span", {
								className: "truncate",
								children: summary ? summary.baseBranch === sharedBase ? summary.headBranch : `${summary.headBranch} → ${summary.baseBranch}` : ref ? `${ref.host}/${ref.repository}` : ""
							})]
						}),
						summary && (summary.additions !== void 0 || summary.deletions !== void 0) ? /* @__PURE__ */ jsx(Pill, {
							className: "ml-auto",
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
//#endregion
//#region src/pr-viewer.tsx
var NO_LINKS = [];
var NO_ROWS = [];
var NONE = {
	getSnapshot: () => void 0,
	subscribe: () => () => {}
};
/** The list failed for a stated reason (doc 73 §9): the fix, with the
*  command in hand, instead of an empty list that reads as "no reviews". */
function UnavailableState({ unavailable }) {
	const advice = reviewsUnavailableAdvice(unavailable);
	const [copied, setCopied] = useState(false);
	return /* @__PURE__ */ jsxs("div", {
		className: "flex flex-col items-start gap-2 p-3",
		"data-slot": "pr-viewer-unavailable",
		"data-reason": unavailable.reason,
		children: [
			/* @__PURE__ */ jsx("span", {
				className: "text-fr-md font-medium text-fr-text",
				children: advice.title
			}),
			/* @__PURE__ */ jsx("span", {
				className: "text-fr-sm text-fr-text-2",
				children: advice.detail
			}),
			advice.command ? /* @__PURE__ */ jsxs("span", {
				className: "inline-flex max-w-full items-center gap-2 rounded-md border border-fr-border bg-fr-surface-3 py-1 pr-1 pl-2.5 text-fr-xs text-fr-text-2",
				children: [/* @__PURE__ */ jsx("code", {
					className: "truncate font-code",
					children: advice.command
				}), /* @__PURE__ */ jsx(Button, {
					size: "sm",
					variant: "ghost",
					onClick: () => {
						navigator.clipboard?.writeText(advice.command ?? "").then(() => setCopied(true));
					},
					children: copied ? "Copied" : "Copy"
				})]
			}) : null
		]
	});
}
/** A review was asked for — by a row, or by a rail chip through the request
*  cell — on a mount with no checkout driver behind it. The host cannot read
*  the detail, so the surface SAYS so and offers the one thing it can do,
*  rather than swallowing the selection and re-rendering the same list. */
function NoDetailView({ reviewRef, summary, link, act, onBack }) {
	return /* @__PURE__ */ jsxs("div", {
		className: "flex min-h-0 min-w-0 flex-1 flex-col",
		"data-slot": "pr-viewer-no-detail",
		children: [/* @__PURE__ */ jsxs("header", {
			className: "flex min-w-0 items-center gap-1.5 border-fr-border-soft border-b px-3 py-1.5",
			children: [/* @__PURE__ */ jsx(Button, {
				size: "icon",
				variant: "ghost",
				className: "-ml-2.5",
				"aria-label": "Back to this session's reviews",
				onClick: onBack,
				children: /* @__PURE__ */ jsx(Icon, {
					name: "back",
					size: 13
				})
			}), /* @__PURE__ */ jsxs("span", {
				className: "flex items-center gap-1.5 text-fr-sm text-fr-text-2 tabular-nums",
				children: [/* @__PURE__ */ jsx(GitHubPullRequestIcon, {
					state: summary ? reviewPillState(summary) : "open",
					size: 12
				}), /* @__PURE__ */ jsxs("span", { children: ["#", reviewRef.number] })]
			})]
		}), /* @__PURE__ */ jsxs("div", {
			className: "flex flex-col items-start gap-2 p-3",
			children: [
				/* @__PURE__ */ jsx("span", {
					className: "text-fr-md font-medium text-fr-text",
					children: summary?.title ?? `#${reviewRef.number}`
				}),
				/* @__PURE__ */ jsxs(Pill, {
					className: "min-w-0 max-w-full justify-start",
					children: [/* @__PURE__ */ jsx(Icon, {
						name: "git-branch",
						size: 12,
						strokeWidth: 1.6
					}), /* @__PURE__ */ jsxs("span", {
						className: "truncate",
						children: [
							reviewRef.host,
							"/",
							reviewRef.repository
						]
					})]
				}),
				/* @__PURE__ */ jsx("span", {
					className: "text-fr-sm text-fr-text-2",
					children: "This mount has no checkout behind it, so the review's detail, threads and diff cannot be read here."
				}),
				/* @__PURE__ */ jsxs(Button, {
					size: "sm",
					variant: "outline",
					"aria-label": `Open on ${reviewRef.host}`,
					onClick: () => act("openReview", {
						ref: reviewRef,
						url: summary?.url ?? link?.url ?? "",
						external: true
					}),
					children: [
						/* @__PURE__ */ jsx(Icon, {
							name: "external",
							size: 12
						}),
						" Open on ",
						reviewRef.host
					]
				})
			]
		})]
	});
}
function PrViewer({ sessionId, workspace, workspaceDriver, store }) {
	const facts = useStandardSessionFacts(sessionId);
	const links = useMemo(() => visibleReviews(facts.reviews ?? NO_LINKS), [facts.reviews]);
	const checkout = useObservable(useMemo(() => store && workspace ? store.watch(`workspace/${workspace.workspaceId}/reviews`) : NONE, [store, workspace]));
	const actionFact = useObservable(useMemo(() => store && workspace ? store.watch(`workspace/${workspace.workspaceId}/scmAction`) : NONE, [store, workspace]));
	const settledActions = actionFact?.action === "reviewAction" && actionFact.state === "settled" ? actionFact.settledAt ?? 0 : 0;
	const settledResult = actionFact?.action === "reviewAction" && actionFact.state === "settled" ? actionFact.result : void 0;
	const refusal = settledResult && typeof settledResult === "object" && "ok" in settledResult && settledResult.ok === false ? "message" in settledResult && typeof settledResult.message === "string" ? settledResult.message : "refused" : null;
	const actionNotice = actionFact?.action === "reviewAction" && actionFact.state === "settled" ? actionFact.error ?? refusal : null;
	const unavailable = useObservable(useMemo(() => store && workspace ? store.watch(`workspace/${workspace.workspaceId}/reviewsUnavailable`) : NONE, [store, workspace]));
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
		const first = links[0]?.ref ?? checkout?.[0]?.ref;
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
	const bases = /* @__PURE__ */ new Set();
	const owners = /* @__PURE__ */ new Set();
	for (const line of lines) {
		const summary = summaryFor(line.link);
		if (summary?.baseBranch) bases.add(summary.baseBranch);
		if (summary?.author) owners.add(summary.author.login);
	}
	for (const row of others) {
		bases.add(row.baseBranch);
		if (row.author) owners.add(row.author.login);
	}
	const sharedBase = bases.size === 1 ? [...bases][0] : null;
	const sharedOwner = owners.size === 1 ? [...owners][0] : null;
	const selectedSummary = selected ? selectedLink ? summaryFor(selectedLink) : checkout?.find((row) => refKey(row.ref) === refKey(selected)) ?? null : null;
	if (selected) {
		const back = links.length + others.length > 1 || !selectedLink ? () => setSelected(null) : null;
		return workspace && workspaceDriver ? /* @__PURE__ */ jsx(DetailView, {
			reviewRef: selected,
			summary: selectedSummary,
			link: selectedLink,
			workspace,
			driver: workspaceDriver,
			act,
			onBack: back,
			settledActions,
			actionNotice
		}, refKey(selected)) : /* @__PURE__ */ jsx(NoDetailView, {
			reviewRef: selected,
			summary: selectedSummary,
			link: selectedLink,
			act,
			onBack: () => setSelected(null)
		});
	}
	const rowMenu = (ref, url, link, summary) => /* @__PURE__ */ jsx(RowMenu, { actions: [
		{
			label: "Open on the host",
			onClick: () => act("openReview", {
				ref,
				url,
				external: true
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
				children: [lines.length === 0 && others.length === 0 && unavailable ? /* @__PURE__ */ jsx(UnavailableState, { unavailable }) : lines.length === 0 ? /* @__PURE__ */ jsxs("div", {
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
				}) : null, /* @__PURE__ */ jsx("div", {
					className: "flex flex-col gap-2",
					children: lines.map((line) => /* @__PURE__ */ jsx(ReviewRow, {
						summary: summaryFor(line.link),
						link: line.link,
						depth: line.depth,
						stack: line.stack,
						sharedBase,
						sharedOwner,
						onSelect: () => setSelected(line.link.ref),
						menu: rowMenu(line.link.ref, line.link.url, line.link)
					}, refKey(line.link.ref)))
				})] }), others.length > 0 ? /* @__PURE__ */ jsxs(Fragment, { children: [/* @__PURE__ */ jsx("div", {
					className: "px-2 pt-5 pb-2 text-fr-sm font-semibold text-fr-text",
					children: "Also in this checkout"
				}), /* @__PURE__ */ jsx("div", {
					className: "flex flex-col gap-2",
					children: others.map((row) => /* @__PURE__ */ jsx(ReviewRow, {
						summary: row,
						depth: 0,
						stack: null,
						sharedBase,
						sharedOwner,
						onSelect: () => setSelected(row.ref),
						menu: rowMenu(row.ref, row.url, void 0, row)
					}, refKey(row.ref)))
				})] }) : null]
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

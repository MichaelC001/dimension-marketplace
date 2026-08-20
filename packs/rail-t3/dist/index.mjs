import { Icon, SURFACE, cn } from "@fraym/ui";
import { memo, useCallback, useState } from "react";
import { Fragment, jsx, jsxs } from "react/jsx-runtime";
//#region src/partition.ts
/** Map ActivityState to T3Status for display.
*
* ActivityState values from @fraym/config:
* - working → "working"
* - needs-you → "attention"
* - failed → "failed"
* - background → "done"
* - ok, idle, attached, off → "ready"
*/
function t3Status(item) {
	switch (item.status) {
		case "working": return "working";
		case "needs-you": return "attention";
		case "failed": return "failed";
		case "background": return "done";
		default: return "ready";
	}
}
/** Sort urgency for live rows (attention > failed > working > done > active-ready) */
function liveStatusPriority(status, active) {
	const basePriority = {
		attention: 0,
		failed: 1,
		working: 2,
		done: 3,
		ready: 4
	}[status];
	return active ? basePriority + 100 : basePriority;
}
/** Compare two dates, using fallbacks (updatedAt > createdAt, stable). */
function compareDates(a, b) {
	const aDate = a.updatedAt || a.createdAt || "1970-01-01";
	const bDate = b.updatedAt || b.createdAt || "1970-01-01";
	return new Date(bDate).getTime() - new Date(aDate).getTime();
}
/** Partition sessions into live (work), quiet (slim rows), and settled (archived).
*
* Filters optional search case-insensitively against item.title and item.branch.
* Sorts: live by urgency then date desc; quiet by date desc; settled by date desc.
*/
function partitionSessions(groups, search) {
	const liveRows = [];
	const quietRows = [];
	const settledRows = [];
	const searchLower = search?.toLowerCase() || "";
	const matchesSearch = (text) => {
		if (!search) return true;
		return text.toLowerCase().includes(searchLower);
	};
	for (const group of groups) for (const item of group.items) {
		const titleMatch = matchesSearch(item.title);
		const branchMatch = matchesSearch(item.worktreeBranch ?? item.branch ?? group.branch ?? "");
		if (!titleMatch && !branchMatch) continue;
		const status = t3Status(item);
		const row = {
			item,
			group,
			status
		};
		if (item.archived) settledRows.push(row);
		else if (status === "working" || status === "attention" || status === "failed" || status === "done" || item.active) liveRows.push(row);
		else quietRows.push(row);
	}
	liveRows.sort((a, b) => {
		const aPriority = liveStatusPriority(a.status, a.item.active || false);
		const bPriority = liveStatusPriority(b.status, b.item.active || false);
		if (aPriority !== bPriority) return aPriority - bPriority;
		return compareDates(a.item, b.item);
	});
	quietRows.sort((a, b) => compareDates(a.item, b.item));
	settledRows.sort((a, b) => compareDates(a.item, b.item));
	return {
		live: liveRows,
		quiet: quietRows,
		settled: settledRows
	};
}
//#endregion
//#region src/t3-rail.tsx
/** Map rail action targets to their mounted surfaces.
*  Reference: fraym/packages/ui/src/shell/fraym-frame-rail-core.tsx:406-411 (RAIL_TARGET_SURFACE)
*  Note: This is a community-authored rail outside fraym; the mapping is replicated per doc 56 §3.3.1 gap #2.
*/
var RAIL_TARGET_SURFACE = {
	loops: SURFACE.autonomy,
	models: SURFACE.models,
	memory: SURFACE.palace,
	lab: SURFACE.lab
};
/** Determine a rail action's active state based on its target and activeSurface. */
function railActionActive(action, activeSurface) {
	const mountSurface = action.target === "surface" ? action.surface : RAIL_TARGET_SURFACE[action.target];
	return mountSurface !== void 0 && mountSurface === activeSurface;
}
/** Map a rail action's target onto a ShellIntent for emission.
*  Reference: fraym/packages/ui/src/shell/fraym-frame-rail-core.tsx:427-451 (railActionClick)
*  Note: This is a community-authored rail; the mapping is replicated per doc 56 §3.3.1 gap #2.
*/
function railActionIntent(action, onIntent, onNewSession) {
	if (action.disabled) return;
	const mountSurface = RAIL_TARGET_SURFACE[action.target];
	if (mountSurface) {
		onIntent({
			t: "mount",
			surface: mountSurface
		});
		return;
	}
	switch (action.target) {
		case "new-session":
			onIntent({ t: "create" });
			onNewSession?.();
			return;
		case "plugins":
			onIntent({
				t: "door",
				route: "settings",
				pane: "mcp"
			});
			return;
		case "surface":
			if (action.surface) onIntent({
				t: "mount",
				surface: action.surface
			});
			return;
		default: onIntent({
			t: "door",
			route: "settings"
		});
	}
}
/** Status treatment — OURS, not T3's (owner 2026-08-03: "don't copy blatantly;
*  we have a vibr that shows working"). Color stays reserved for act-now, and
*  only act-now gets WORDS: attention/failed speak, working is a quiet breathing
*  dot (the product's own dot language — the Vibr narrates activity elsewhere),
*  done is a bare check glyph. Ready stays unmarked. */
function statusDisplay(status) {
	switch (status) {
		case "attention": return {
			color: "var(--fr-warn)",
			label: "Needs you"
		};
		case "failed": return {
			color: "var(--fr-del)",
			label: "Failed"
		};
		case "working": return {
			color: "var(--fr-blue)",
			dot: true
		};
		case "done": return {
			color: "var(--fr-add)",
			icon: "check"
		};
		default: return {};
	}
}
/** Card row for live sessions. */
var LiveCard = memo(function LiveCard({ item, group, status, isActive, onSelect, onContextMenu }) {
	const display = statusDisplay(status);
	const emphatic = status === "attention" || status === "failed" || item.active;
	return /* @__PURE__ */ jsxs("button", {
		onClick: () => onSelect?.(item),
		onContextMenu: (e) => {
			e.preventDefault();
			onContextMenu(item, e);
		},
		className: cn("w-full rounded-lg border px-2.5 py-2 text-left transition-colors duration-[var(--fr-motion-fast)]", isActive ? "border-fr-border bg-fr-surface-2" : "border-fr-border-soft bg-fr-surface-1/50 hover:bg-fr-surface-2/60"),
		style: { contentVisibility: "auto" },
		children: [
			/* @__PURE__ */ jsxs("div", {
				className: "mb-1 flex items-center justify-between gap-2",
				children: [/* @__PURE__ */ jsxs("div", {
					className: "flex min-w-0 items-center gap-1.5",
					children: [group.image ? /* @__PURE__ */ jsx("img", {
						src: group.image,
						alt: "",
						className: "h-4 w-4 shrink-0 rounded"
					}) : group.emoji ? /* @__PURE__ */ jsx("span", {
						className: "h-4 w-4 shrink-0 text-center text-xs leading-4",
						children: group.emoji
					}) : /* @__PURE__ */ jsx(Icon, {
						name: group.icon ?? "folder",
						className: "h-4 w-4 shrink-0"
					}), /* @__PURE__ */ jsx("span", {
						className: "truncate font-secondary text-[10px] text-fr-text-3",
						children: group.repo
					})]
				}), /* @__PURE__ */ jsxs("div", {
					className: "flex shrink-0 items-center gap-1.5",
					children: [display.label ? /* @__PURE__ */ jsx("span", {
						className: "font-secondary text-[10px] font-medium",
						style: { color: display.color },
						children: display.label
					}) : display.icon ? /* @__PURE__ */ jsx(Icon, {
						name: display.icon,
						className: "h-3 w-3",
						style: { color: display.color }
					}) : display.dot ? /* @__PURE__ */ jsx("span", {
						className: "h-1.5 w-1.5 rounded-full animate-pulse motion-reduce:animate-none",
						style: { background: display.color }
					}) : null, item.time && /* @__PURE__ */ jsx("span", {
						className: "font-secondary text-fr-2xs text-fr-text-3",
						children: item.time
					})]
				})]
			}),
			/* @__PURE__ */ jsx("div", {
				className: cn("mb-1 truncate text-fr-sm", emphatic ? "font-medium text-fr-text" : "font-normal text-fr-text-2"),
				children: item.title
			}),
			/* @__PURE__ */ jsx("div", {
				className: "truncate font-secondary text-fr-2xs text-fr-text-3",
				children: item.worktreeBranch || item.branch || group.branch || ""
			})
		]
	});
});
/** Slim row for quiet sessions. */
var QuietRow = memo(function QuietRow({ item, group, onSelect, onContextMenu }) {
	return /* @__PURE__ */ jsxs("button", {
		onClick: () => onSelect?.(item),
		onContextMenu: (e) => {
			e.preventDefault();
			onContextMenu(item, e);
		},
		className: cn("flex h-8 w-full items-center gap-2 rounded-md px-2.5 text-left", "opacity-65 transition-opacity duration-[var(--fr-motion-fast)] hover:opacity-100"),
		style: { contentVisibility: "auto" },
		children: [
			group.image ? /* @__PURE__ */ jsx("img", {
				src: group.image,
				alt: "",
				className: "h-3.5 w-3.5 shrink-0 rounded"
			}) : group.emoji ? /* @__PURE__ */ jsx("span", {
				className: "h-3.5 w-3.5 shrink-0 text-center text-[10px] leading-[14px]",
				children: group.emoji
			}) : /* @__PURE__ */ jsx(Icon, {
				name: group.icon ?? "folder",
				className: "h-3.5 w-3.5 shrink-0 text-fr-text-3"
			}),
			/* @__PURE__ */ jsx("span", {
				className: "min-w-0 flex-1 truncate text-left text-fr-xs text-fr-text-2",
				children: item.title
			}),
			item.time && /* @__PURE__ */ jsx("span", {
				className: "shrink-0 font-secondary text-fr-2xs text-fr-text-3",
				children: item.time
			})
		]
	});
});
/** Settled shelf (collapsed by default). */
var SettledShelf = memo(function SettledShelf({ rows, onSelect, onContextMenu }) {
	const [open, setOpen] = useState(false);
	if (rows.length === 0) return null;
	return /* @__PURE__ */ jsxs("div", {
		className: "border-t border-fr-border-soft mt-2 pt-2",
		children: [/* @__PURE__ */ jsxs("button", {
			onClick: () => setOpen(!open),
			className: "w-full px-2.5 py-1.5 flex items-center gap-2 text-fr-2xs font-semibold text-fr-text-3 uppercase tracking-[0.08em] transition-opacity hover:opacity-75",
			children: [
				/* @__PURE__ */ jsx(Icon, {
					name: "caretD",
					className: cn("w-3 h-3 transition-transform duration-[var(--fr-motion-fast)]", !open && "-rotate-90")
				}),
				"Settled (",
				rows.length,
				")"
			]
		}), open && /* @__PURE__ */ jsx("div", {
			className: "space-y-1 mt-2",
			children: rows.map(({ item, group }) => /* @__PURE__ */ jsx(QuietRow, {
				item,
				group,
				onSelect,
				onContextMenu
			}, item.id))
		})]
	});
});
/** Pager for quiet rows: initial 10, +25 per click. */
var QuietPager = memo(function QuietPager({ rows, onSelect, onContextMenu }) {
	const [limit, setLimit] = useState(10);
	const visible = rows.slice(0, limit);
	const hidden = rows.length - limit;
	return /* @__PURE__ */ jsxs(Fragment, { children: [/* @__PURE__ */ jsx("div", {
		className: "space-y-1",
		children: visible.map(({ item, group }) => /* @__PURE__ */ jsx(QuietRow, {
			item,
			group,
			onSelect,
			onContextMenu
		}, item.id))
	}), hidden > 0 && /* @__PURE__ */ jsxs("button", {
		onClick: () => setLimit((l) => l + 25),
		className: "w-full mt-2 px-2.5 py-1 text-fr-2xs text-fr-text-3 hover:text-fr-text transition-colors",
		children: [
			"Show ",
			Math.min(25, hidden),
			" more"
		]
	})] });
});
function T3Rail(props) {
	const compact = props.railMode === "compact";
	const actions = props.spaces.find((s) => s.id === props.appMode)?.rail.actions ?? [];
	const [projectFilter, setProjectFilter] = useState(null);
	const partition = partitionSessions(projectFilter ? props.groups.filter((g) => g.repo === projectFilter) : props.groups, props.sessionSearch);
	const handleActionClick = useCallback((action) => {
		railActionIntent(action, props.onIntent, () => props.onNewSession?.(props.groups[0]?.workspace));
	}, [props]);
	return /* @__PURE__ */ jsxs("aside", {
		"data-slot": "session-rail",
		className: "flex h-full min-h-0 flex-col overflow-hidden bg-transparent",
		children: [
			/* @__PURE__ */ jsx("div", {
				className: "px-3 py-2 border-b border-fr-border-soft",
				children: /* @__PURE__ */ jsxs("div", {
					className: "flex items-center justify-between",
					children: [/* @__PURE__ */ jsx("div", {
						className: "text-fr-sm font-semibold text-fr-text tracking-tight",
						children: props.productLabel || "Dimension"
					}), !compact && props.version && /* @__PURE__ */ jsx("div", {
						className: "text-fr-2xs text-fr-text-3",
						children: props.version
					})]
				})
			}),
			/* @__PURE__ */ jsx("div", {
				"data-slot": "rail-actions",
				className: "flex flex-col gap-1 px-1.5 py-2",
				children: actions.map((action) => {
					const active = railActionActive(action, props.activeSurface);
					const primary = action.primary === true;
					return /* @__PURE__ */ jsxs("button", {
						"data-slot": "rail-button",
						onClick: () => handleActionClick(action),
						disabled: action.disabled,
						className: cn("h-8 rounded-md px-2 gap-2 text-fr-xs transition-colors duration-[var(--fr-motion-fast)]", compact ? "w-8 justify-center" : "w-full flex items-center", "disabled:opacity-50 disabled:cursor-not-allowed", primary ? "primary bg-fr-accent-dim text-fr-accent font-medium hover:bg-fr-accent-dim/80" : active ? "bg-fr-surface-2 text-fr-text hover:bg-fr-surface-2" : "text-fr-text-2 hover:bg-fr-surface-3/60 hover:text-fr-text"),
						title: compact ? action.label : void 0,
						children: [action.icon && /* @__PURE__ */ jsx(Icon, {
							name: action.icon,
							className: "w-4 h-4 shrink-0"
						}), !compact && /* @__PURE__ */ jsx("span", { children: action.label })]
					}, action.id);
				})
			}),
			!compact && /* @__PURE__ */ jsx("div", {
				className: "px-1.5 pb-1 pt-2",
				children: props.sessionSearchOpen ? /* @__PURE__ */ jsx("input", {
					ref: props.searchInputRef,
					type: "text",
					value: props.sessionSearch,
					onChange: (e) => props.onSessionSearchChange(e.target.value),
					placeholder: "Search sessions…",
					className: "h-7 w-full rounded-md border border-fr-border bg-fr-surface-2 px-2.5 text-fr-xs text-fr-text placeholder-fr-text-3 focus:border-fr-accent focus:outline-none",
					autoFocus: true
				}) : /* @__PURE__ */ jsxs("button", {
					onClick: () => props.onSessionSearchOpenChange(true),
					className: "flex h-7 w-full items-center gap-2 rounded-md border border-fr-border-soft bg-fr-surface-1/60 px-2.5 text-fr-xs text-fr-text-3 transition-colors hover:border-fr-border hover:text-fr-text-2",
					children: [/* @__PURE__ */ jsx(Icon, {
						name: "search",
						className: "h-3.5 w-3.5"
					}), /* @__PURE__ */ jsx("span", { children: "Search" })]
				})
			}),
			!compact && props.groups.length > 1 && /* @__PURE__ */ jsxs("div", {
				className: "flex items-center gap-1 overflow-x-auto border-b border-fr-border-soft px-1.5 pb-2 pt-1 [scrollbar-width:none]",
				children: [/* @__PURE__ */ jsx("button", {
					onClick: () => setProjectFilter(null),
					className: cn("h-6 shrink-0 rounded-full px-2.5 text-fr-2xs transition-colors", projectFilter === null ? "bg-fr-surface-3 text-fr-text" : "text-fr-text-3 hover:bg-fr-surface-2 hover:text-fr-text-2"),
					children: "All"
				}), props.groups.map((group) => /* @__PURE__ */ jsxs("button", {
					onClick: () => setProjectFilter((current) => current === group.repo ? null : group.repo),
					className: cn("flex h-6 shrink-0 items-center gap-1.5 rounded-full px-2.5 text-fr-2xs transition-colors", projectFilter === group.repo ? "bg-fr-surface-3 text-fr-text" : "text-fr-text-3 hover:bg-fr-surface-2 hover:text-fr-text-2"),
					children: [group.image ? /* @__PURE__ */ jsx("img", {
						src: group.image,
						alt: "",
						className: "h-3 w-3 rounded-sm"
					}) : group.emoji ? /* @__PURE__ */ jsx("span", {
						className: "text-[10px] leading-none",
						children: group.emoji
					}) : /* @__PURE__ */ jsx(Icon, {
						name: group.icon ?? "folder",
						className: "h-3 w-3"
					}), /* @__PURE__ */ jsx("span", {
						className: "max-w-[9ch] truncate",
						children: group.repo
					})]
				}, group.repo))]
			}),
			/* @__PURE__ */ jsx("div", {
				className: "flex-1 min-h-0 overflow-y-auto px-1.5",
				style: {
					scrollbarWidth: "thin",
					scrollbarColor: "var(--fr-border-soft) transparent"
				},
				children: /* @__PURE__ */ jsxs("div", {
					className: "space-y-1 py-2",
					children: [
						partition.live.length > 0 ? /* @__PURE__ */ jsx("div", {
							className: "space-y-1",
							children: partition.live.map((row) => /* @__PURE__ */ jsx(LiveCard, {
								item: row.item,
								group: row.group,
								status: row.status,
								isActive: row.item.active || false,
								onSelect: props.onSessionSelect,
								onContextMenu: props.onSessionContextMenu
							}, row.item.id))
						}) : null,
						partition.quiet.length > 0 && /* @__PURE__ */ jsxs("div", {
							className: "pt-1",
							children: [partition.live.length > 0 && /* @__PURE__ */ jsx("div", { className: "mx-2.5 my-2 border-t border-fr-border-soft" }), /* @__PURE__ */ jsx(QuietPager, {
								rows: partition.quiet,
								onSelect: props.onSessionSelect,
								onContextMenu: props.onSessionContextMenu
							})]
						}),
						partition.settled.length > 0 && /* @__PURE__ */ jsx(SettledShelf, {
							rows: partition.settled,
							onSelect: props.onSessionSelect,
							onContextMenu: props.onSessionContextMenu
						}),
						partition.live.length === 0 && partition.quiet.length === 0 && partition.settled.length === 0 && /* @__PURE__ */ jsx("div", {
							className: "flex items-center justify-center h-full text-fr-2xs text-fr-text-3",
							children: "No sessions yet."
						})
					]
				})
			}),
			!compact && /* @__PURE__ */ jsx("div", {
				className: "px-3 py-2 border-t border-fr-border-soft",
				children: /* @__PURE__ */ jsxs("button", {
					onClick: (e) => props.onOpenUserMenu(e),
					className: "w-full flex items-center gap-2 hover:opacity-75 transition-opacity",
					children: [/* @__PURE__ */ jsx("div", {
						className: "h-6 w-6 rounded-full bg-fr-surface-3 grid place-items-center shrink-0 text-[10px] text-fr-text font-semibold",
						children: props.userName.charAt(0).toUpperCase()
					}), /* @__PURE__ */ jsxs("div", {
						className: "flex-1 min-w-0 text-left",
						children: [/* @__PURE__ */ jsx("div", {
							className: "text-fr-xs text-fr-text-2 truncate",
							children: props.userName
						}), props.planLabel && /* @__PURE__ */ jsx("div", {
							className: "text-fr-2xs text-fr-text-3 truncate",
							children: props.planLabel
						})]
					})]
				})
			})
		]
	});
}
var T3_RAIL = {
	specVersion: 1,
	id: "rail-t3",
	slot: "rail",
	component: T3Rail
};
//#endregion
export { T3Rail, T3Rail as default, T3_RAIL, partitionSessions, t3Status };

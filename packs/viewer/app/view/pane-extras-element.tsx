// The page-picking layer (docs/design/88 section 2): point at the element you mean, say what
// should change about it, and the agent gets its selector, its words and its box.
//
// What lives HERE is only the seating, like `PictureMarkup` beside it: where the frames are, where
// the pick tools (a strip docked under the toolbar, never over the page) and the list go, and the
// rules that come from the pane. The picking is the kit's (`@dimension/mcp-app-kit/annotate`), and
// so is every rule about a page that may be hostile.
//   * the READING frame is `[data-slot="viewer-html-frame"]`, drawn by `renderers/html.ts` with
//     `sandbox=""`: it runs nothing, for anyone, and is never changed. In Pick mode the kit adds a PICK
//     frame over it, made from its `srcdoc`, and removes it again when the mode ends;
//   * the renderer re-mounts (a theme, a changed file), replacing the reading frame, so the slot is
//     looked up again each time it says `ready`, and the kit builds a new pick frame for the new one;
//   * every open document keeps its own pane mounted, so the picker lives only for the tab on screen.
import {
	AnnotationPanel,
	ElementPicker,
	ElementRowSteps,
	ElementToolbar,
	type PanelItem,
	pickAside,
	useElementPicks,
	useElementShortcuts,
} from "@dimension/mcp-app-kit/annotate/react";
import type { PickKeyIntent } from "@dimension/mcp-app-kit/annotate";
import { type ReactNode, useCallback, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { Column, type PaneExtrasProps, revisionOf, Strip, useSlot } from "./pane-shared";

const HTML_FRAME = '[data-slot="viewer-html-frame"]';

/** About two lines of the list's code face: past this a selector is shown by its last steps. */
const HEADING_CHARS = 56;
const STEP = " > ";

/**
 * A selector as a row's heading: whole when it fits, else its LAST steps behind an ellipsis. The end
 * of a selector is the element itself; its start is where it was found from, which matters least.
 * The whole selector is the row's tooltip and is what the agent receives.
 */
function selectorHeading(selector: string): { heading: string; headingTitle?: string } {
	if (selector.length <= HEADING_CHARS) return { heading: selector };
	const steps = selector.split(STEP);
	let tail = steps.pop() ?? selector;
	for (let step = steps.pop(); step !== undefined; step = steps.pop()) {
		const longer = `${step}${STEP}${tail}`;
		if (1 + STEP.length + longer.length > HEADING_CHARS) break;
		tail = longer;
	}
	return { heading: tail === selector ? selector : `…${STEP}${tail}`, headingTitle: selector };
}

export function ElementPicks({ app, tab, active, ready, frame, mode, onMode }: PaneExtrasProps): ReactNode {
	const slot = useSlot(frame, ready, HTML_FRAME);
	const reading = slot instanceof HTMLIFrameElement ? slot : null;
	const picking = mode === "elements";
	const live = active && picking;
	// The picker says so when it cannot pick from the page (nothing to run it, or the policy is not enforced).
	const [unreadable, setUnreadable] = useState(false);
	// Each time Pick mode starts, or the page is drawn again, the answer is not known until the picker says.
	// biome-ignore lint/correctness/useExhaustiveDependencies: `live` and `reading` are the triggers.
	useEffect(() => setUnreadable(false), [live, reading]);
	const session = useElementPicks({ app, file: tab.path, rev: revisionOf(tab) });
	const { picks, retarget, activeId } = session;

	// Esc leaves; Alt+Up and Alt+Down widen and narrow the row the human is on, else the newest.
	const onIntent = useCallback(
		(intent: PickKeyIntent) => {
			if (intent === "exit") return onMode(null);
			const id = activeId ?? picks[picks.length - 1]?.id;
			if (id !== undefined) retarget(id, intent === "wider" ? "parent" : "child");
		},
		[activeId, picks, retarget, onMode],
	);
	useElementShortcuts({ enabled: live, onIntent });

	const items = useMemo<PanelItem[]>(
		() =>
			picks.map(pick => ({
				id: pick.id,
				...selectorHeading(pick.target.selector),
				headingStyle: "code",
				aside: pickAside(pick.target.matches),
				note: pick.note,
			})),
		[picks],
	);
	const blocked = live && unreadable;

	return (
		<>
			{frame === null || reading === null
				? null
				: createPortal(
						<ElementPicker
							source={reading}
							active={live}
							link={session.link}
							picks={picks}
							activeId={activeId}
							onPick={session.onPick}
							onMoved={session.onMoved}
							onReady={session.onReady}
							onKey={onIntent}
							onUnpick={session.unpick}
							onUnavailable={setUnreadable}
							label={`Pick from ${tab.filename}`}
						/>,
						frame,
					)}
			{live ? (
				<Strip frame={frame}>
					<ElementToolbar
						onWholePage={session.pickWholePage}
						onDone={() => onMode(null)}
						unavailable={unreadable}
						full={session.full}
						placement="strip"
					/>
				</Strip>
			) : null}
			{picking ? (
				<Column frame={frame}>
					<AnnotationPanel
						title="Elements"
						items={items}
						activeId={activeId}
						focus={session.focus}
						onActive={session.setActiveId}
						onNote={session.setNote}
						onRemove={session.remove}
						message={session.message}
						onMessage={session.setMessage}
						onSend={() => void session.send()}
						send={{ busy: session.sending, staged: session.staged }}
						status={session.status}
						rowKeys
						rowActions={item => (
							<ElementRowSteps
								can={session.steps.get(item.id)}
								onWider={() => retarget(item.id, "parent")}
								onNarrower={() => retarget(item.id, "child")}
							/>
						)}
						emptyHint={
							blocked ? (
								<>
									<strong>Can't pick from this page</strong>
									<span>
										The viewer couldn't look inside it safely, so it can't tell what you point at. Say
										what should change in the chat instead.
									</span>
								</>
							) : (
								<>
									<strong>Pick from the page</strong>
									<span>
										Point at what you mean and click it. <kbd>Alt</kbd>+<kbd>↑</kbd> then picks the
										element around it. Press <kbd>Esc</kbd> when you are done.
									</span>
								</>
							)
						}
					/>
				</Column>
			) : null}
		</>
	);
}

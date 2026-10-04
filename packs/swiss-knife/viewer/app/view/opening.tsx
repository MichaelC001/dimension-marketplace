// The View's opening surface: what a document waits behind from the View's first paint until its content is ready.
// It is the SAME component the host puts over the iframe until the handshake completes (`ArtifactOpening`, @fraym/ui),
// so the host's surface hands over to this one without a blank frame or a different card; this file only says what the
// viewer's three REAL stages are called and how far the one in progress has got.
//
//   connect  no tool result yet: the host has not told this View what to open
//   read     the bytes are streaming in (`loaded` of `total` are the real counts)
//   prepare  the bytes are in hand and the renderer is being loaded and the document decoded, until it is ready
//
// A stage that has not begun reads pending, one that is over reads done: nothing here is a timer.
//
// THE FIRST WAIT. The View puts up three of these in turn while its first file opens (the shell's fallback until the
// handshake, the empty pane until the tool result, then the file's own pane), and each is a new component instance.
// Each one counting its own 150 ms of silence would blink the words out at every hand-over, and the host's surface
// (fading over the View for a motion beat after the handshake) would sit over a View that has said nothing yet. So the
// silence of everything in the first wait is counted from the DOCUMENT's start: the host mounts its surface in the same
// commit as the iframe whose document this is, so the document's age IS the host surface's age, and a View surface that
// opens at age A stays quiet for exactly as long as the host's still would (none at all once the host has spoken).
// One surface above the shell could not do this job instead: each pane's stage lives in that pane's own state, and the
// surface covers the pane's stage and not the toolbar. A file opened later, in a View that is long past its start, is a
// wait of its own with its own silence; only a surface wrapped in {@link FirstWait} counts from the document's start,
// and only until the first of them leaves: the next one to mount under the same {@link FirstWait} (Try again after an
// error, which takes the surface out of the tree) is a new wait too.
import { ARTIFACT_OPENING_CONNECT_LABEL, ArtifactOpening } from "@fraym/ui/components/artifact-opening";
import type { LaborStatus, LaborStep } from "@fraym/ui/components/labor";
import { createContext, type ReactNode, useContext, useEffect, useMemo, useRef, useState } from "react";
import { formatBytes } from "./format";

export type OpeningStage = "connect" | "read" | "prepare";

const STAGES: readonly OpeningStage[] = ["connect", "read", "prepare"];

/** `performance.now()` is measured from the document's own start. */
const DOCUMENT_START = 0;

/** What a {@link FirstWait} tells the surfaces under it. */
interface FirstWaitCredit {
	/** Whether a surface that mounts now stands for the first wait. Read once, at mount. */
	readonly owed: () => boolean;
	/** A surface is on screen; the result says it left. */
	readonly attend: () => () => void;
}

const NoCredit: FirstWaitCredit = { owed: () => false, attend: () => () => undefined };
const InFirstWait = createContext<FirstWaitCredit>(NoCredit);

/** Marks the surfaces below as part of the View's FIRST wait, whose silence is counted from the document's start
 *  rather than from each surface's own mount (see the note at the top of this file). `of={false}` leaves them out, so
 *  a pane that is not in the first wait keeps the same tree shape as one that is. `of` is for the life of the
 *  component: a pane is in the first wait from the commit it appears in, or never. */
export function FirstWait({ of = true, children }: { readonly of?: boolean; readonly children: ReactNode }) {
	const state = useRef({ over: !of, shown: 0 });
	const credit = useMemo<FirstWaitCredit>(
		() => ({
			owed: () => !state.current.over,
			attend: () => {
				state.current.shown += 1;
				return () => {
					state.current.shown -= 1;
					// A surface that leaves and comes straight back in the same commit is React testing its effects
					// (StrictMode), not the wait ending: look again once the commit has settled.
					queueMicrotask(() => {
						if (state.current.shown === 0) state.current.over = true;
					});
				};
			},
		}),
		[],
	);
	return <InFirstWait.Provider value={credit}>{children}</InFirstWait.Provider>;
}

export interface OpeningProps {
	/** The file's name; empty while it is not known yet (before the first tool result). */
	readonly name: string;
	readonly stage: OpeningStage;
	/** Bytes read so far, with `total`: the real counts of the `read` stage. */
	readonly loaded?: number;
	readonly total?: number;
	/** Whether the surface is up. `false` once the document is ready: it fades out over the content. Default `true`. */
	readonly open?: boolean;
	readonly className?: string;
}

/** What a stage is doing to the file. The name is the file's own and may carry anything (a right-to-left override
 *  included), so it travels as the step's `subject`, which the row draws in a bidi isolate; no name reads "the file". */
function about(verb: string, name: string): Pick<LaborStep, "label" | "subject"> {
	return name === "" ? { label: `${verb} the file` } : { label: verb, subject: name };
}

export function Opening({ name, stage, loaded, total, open = true, className }: OpeningProps) {
	const credit = useContext(InFirstWait);
	// Decided once, when the surface mounts: it is the surface's first opening that the document's age belongs to.
	const [since] = useState(() => (credit.owed() ? DOCUMENT_START : undefined));
	useEffect(() => credit.attend(), [credit]);
	const reading = stage === "read" && total !== undefined && total > 0 && loaded !== undefined;
	// The label holds still for the whole stage (it sits in a live region, and a changed label is read aloud); the
	// counts tick, so they are the step's `detail`, which the row hides from assistive tech.
	const words: Record<OpeningStage, Pick<LaborStep, "label" | "subject" | "detail">> = {
		connect: { label: ARTIFACT_OPENING_CONNECT_LABEL },
		read: { ...about("Reading", name), detail: reading ? `${formatBytes(loaded)} of ${formatBytes(total)}` : undefined },
		prepare: about("Preparing", name),
	};
	const at = STAGES.indexOf(stage);
	const steps: LaborStep[] = STAGES.map((id, index) => {
		const status: LaborStatus = index < at ? "done" : index === at ? "active" : "pending";
		return { id, ...words[id], status };
	});
	return (
		<ArtifactOpening
			steps={steps}
			open={open}
			since={since}
			progress={reading ? loaded / total : undefined}
			className={className}
		/>
	);
}

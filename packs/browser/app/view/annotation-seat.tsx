// The seat for marking up the page. The human froze the page into one picture; this lays the shared annotation kit
// over it exactly as the Viewer does on a picture: the marks, the tool strip, each note in place beside its mark,
// staging as the human writes, the burned-in picture and its limits are all `@dimension/mcp-app-kit/annotate`. What
// is the Browser's is what a picture of a PAGE needs beyond that (`page-annotation.ts`): which page, how far it was
// scrolled, what is under each mark.
//
// The picture is shown at the page's own aspect and the real browser's viewport is never touched while the human
// marks: nothing here is measured against the page, so the elements read at send time are read at the size the
// picture was taken at.
import {
	AnnotationNotice,
	AnnotationToolbar,
	MarkupIcon,
	MarkupOverlay,
	markupToolGroups,
	useImageMarkup,
	useMarkupShortcuts,
} from "@dimension/mcp-app-kit/annotate/react";
import type { App } from "@modelcontextprotocol/ext-apps";
import { type CSSProperties, type ReactNode, useCallback, useEffect, useMemo, useState } from "react";
import type { BrowserFrame } from "../../src/contracts";
import type { BrowserClient } from "./browser-client";
import { captureName, PAGE_DETAIL_KIND, pageAttach, pageEnrich } from "./page-annotation";

export interface AnnotationSeatProps {
	readonly app: App;
	readonly client: BrowserClient;
	readonly browserId: string;
	/** The png the human froze: the picture they mark, and the frame the page is read against. */
	readonly frame: BrowserFrame;
	/** What floats over the page while it is marked (the agent's pill, a post awaiting its Post). */
	readonly floats?: ReactNode;
	/** The human is finished marking. What was staged stays staged; it is theirs to send. */
	readonly onDone: () => void;
}

function bytesOf(base64: string): Uint8Array {
	const text = atob(base64);
	const bytes = new Uint8Array(text.length);
	for (let i = 0; i < text.length; i += 1) bytes[i] = text.charCodeAt(i);
	return bytes;
}

export function AnnotationSeat({ app, client, browserId, frame, floats, onDone }: AnnotationSeatProps) {
	// The kit stages through whatever it is handed. It is handed the client's own channel, so a request about this
	// browser is taken back when the View moves to another (BrowserClient.follow) and never lands on the wrong one.
	const host = useMemo<Parameters<typeof useImageMarkup>[0]["app"]>(
		() => ({
			getHostCapabilities: () => app.getHostCapabilities(),
			updateModelContext: async params => {
				if (!(await client.updateContext(browserId, params.content ?? []))) {
					throw new Error("The View moved to another browser. Nothing was sent.");
				}
				return {};
			},
		}),
		[app, client, browserId],
	);
	const enrich = useMemo(
		() => pageEnrich(client, browserId, { frameId: frame.frameId, viewport: frame.state.viewport }),
		[client, browserId, frame.frameId, frame.state.viewport],
	);
	const attach = useMemo(() => pageAttach(client, browserId), [client, browserId]);
	const bytes = useMemo(() => bytesOf(frame.data), [frame.data]);

	// dimension#1465: the kit's message says "Change ONLY what is marked; leave the rest of the image as it is." for every
	// picture. For a live page that reads as editing an image; this seat passes its own scope sentence once the kit has the option.
	const session = useImageMarkup({
		app: host,
		file: captureName(frame.state.url),
		loadBytes: () => Promise.resolve(bytes),
		enrich,
		attach,
		detailKind: PAGE_DETAIL_KIND,
		autoStage: true,
	});
	const { markup, setTool, staged, sending, send } = session;

	// Entering arms the box tool: the first thing a person does is drag one.
	useEffect(() => {
		setTool("box");
	}, [setTool]);
	// Leaving unmounts the seat, which clears the kit's quiet-interval staging timer, so what is not yet staged is
	// staged on the way out. A stage already in flight carries older words and refuses a second send until it
	// lands: the seat stays until it does, then stages the newest wording and leaves.
	const [leaving, setLeaving] = useState(false);
	const done = useCallback(() => {
		if (sending) {
			setLeaving(true);
			return;
		}
		if (markup.marks.length > 0 && !staged) void send();
		onDone();
	}, [markup.marks.length, staged, sending, send, onDone]);
	useEffect(() => {
		if (!leaving || sending) return;
		if (markup.marks.length > 0 && !staged) void send();
		onDone();
	}, [leaving, sending, staged, markup.marks.length, send, onDone]);
	useMarkupShortcuts({ enabled: true, onTool: setTool, onUndo: markup.undo, onRedo: markup.redo, onExit: done });

	const { viewport } = frame.state;
	const page = { "--vw": viewport.width, "--vh": viewport.height } as CSSProperties;

	return (
		<div className="bx-seat" data-slot="annotation-seat">
			<AnnotationToolbar
				label="Annotation tools"
				placement="strip"
				groups={[
					...markupToolGroups({
						tool: session.tool,
						onTool: setTool,
						canUndo: markup.canUndo,
						canRedo: markup.canRedo,
						onUndo: markup.undo,
						onRedo: markup.redo,
						onClear: markup.clear,
						hasMarks: markup.marks.length > 0,
					}),
					// Unlike the Viewer's always-on bar, this seat REPLACES the live page with a frozen picture, entered on
					// purpose (the Browser's Annotate toggle), so its bar ends in the labelled way back to the page: Done.
					{
						id: "seat",
						label: "Seat",
						kind: "act",
						tools: [{ id: "done", label: "Done", text: "Done", key: "Esc", icon: <MarkupIcon name="check" size={15} />, onSelect: done }],
					},
				]}
			/>
			<div className="bx-stage" data-mode="annotate">
				<div className="bx-page" style={page}>
					<img
						className="bx-frame"
						src={`data:${frame.mimeType};base64,${frame.data}`}
						width={viewport.width}
						height={viewport.height}
						alt=""
						draggable={false}
					/>
					<MarkupOverlay
						marks={markup.marks}
						tool={session.tool}
						onShape={session.onShape}
						onNote={markup.setNote}
						onRemove={markup.remove}
						label="Draw on the page"
					/>
					{floats === undefined ? null : <div className="bx-floats">{floats}</div>}
				</div>
			</div>
			<AnnotationNotice status={session.status} />
		</div>
	);
}

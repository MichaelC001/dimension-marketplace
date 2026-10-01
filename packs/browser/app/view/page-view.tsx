// The page itself: the live picture, fitted to the seat at the viewport's own
// aspect, and every direct input a human makes on it — click, double/triple
// click, right and middle click, wheel, hover and typing — mapped from seat
// pixels to viewport pixels and handed to `onAction`. Marking the page up is
// not done here: the human freezes it into one picture and the annotation seat
// (annotation-seat.tsx) lays the shared annotation kit over that picture.
//
// One coordinate space rules: `viewport` CSS pixels, so a click lands on the
// same pixel of the page whatever size the seat renders the picture at.
import {
	type ClipboardEvent as ReactClipboardEvent,
	type CSSProperties,
	type KeyboardEvent as ReactKeyboardEvent,
	type MouseEvent as ReactMouseEvent,
	type PointerEvent as ReactPointerEvent,
	type ReactNode,
	useEffect,
	useRef,
	useState,
} from "react";
import type { BrowserAction, BrowserFrame, Viewport } from "../../src/contracts";
import { type Point, toPixelPoint, toViewportPoint } from "./geometry";

/** Keys the runtime presses by name; everything printable is inserted. */
const NAMED_KEYS: Record<string, true> = {
	Enter: true, Tab: true, Escape: true, Backspace: true, Delete: true, ArrowUp: true, ArrowDown: true,
	ArrowLeft: true, ArrowRight: true, Home: true, End: true, PageUp: true, PageDown: true,
};
/** A sweep of the mouse is a hover where it rests, not a stream. */
const HOVER_INTERVAL_MS = 120;
/** A wheel line / page in pixels, for devices that report in those units. */
const WHEEL_LINE_PX = 40;

interface Ripple {
	readonly id: number;
	readonly x: number;
	readonly y: number;
	readonly kind: "left" | "right" | "middle";
}

/** The floating layers' home. Every event that would otherwise bubble into
 *  the page's input handlers stops here, so typing a note or pressing Stop
 *  is never also sent to the web page underneath. */
export function Overlays({ children }: { readonly children: ReactNode }) {
	const stop = (event: { stopPropagation(): void }) => event.stopPropagation();
	return (
		<div
			className="bx-floats"
			onPointerDown={stop}
			onPointerMove={stop}
			onPointerUp={stop}
			onMouseDown={stop}
			onClick={stop}
			onAuxClick={stop}
			onContextMenu={stop}
			onKeyDown={stop}
			onKeyUp={stop}
			onPaste={stop}
		>
			{children}
		</div>
	);
}

export interface PageViewProps {
	readonly frame: BrowserFrame | null;
	readonly viewport: Viewport;
	/** live: input goes to the page. frozen: the page is being captured for marking, so it takes no input. locked: an agent drives. */
	readonly mode: "live" | "frozen" | "locked";
	readonly onAction: (action: BrowserAction) => void;
	readonly label: string;
	/**
	 * A post awaits confirmation: Tab and Enter stay with the View
	 * (Tab moves on into the confirm bar) instead of reaching the page, where
	 * they could land on and press the site's own submit.
	 */
	readonly confirming?: boolean;
	/** The page area's size in CSS px, whenever it changes (and once on mount). */
	readonly onResize: (width: number, height: number) => void;
	/** Floating layers over the page (annotation strip, agent pill, toasts).
	 *  Their input stays theirs: nothing they receive is forwarded to the page. */
	readonly children?: ReactNode;
}

export function PageView({ frame, viewport, mode, onAction, onResize, label, confirming = false, children }: PageViewProps) {
	const pageRef = useRef<HTMLDivElement | null>(null);
	const stageRef = useRef<HTMLDivElement | null>(null);
	const onResizeRef = useRef(onResize);
	onResizeRef.current = onResize;
	// The seat's page area, in CSS px: the runtime sizes the viewport to it.
	useEffect(() => {
		const stage = stageRef.current;
		if (!stage) return;
		const observer = new ResizeObserver(entries => {
			const box = entries[0]?.contentRect;
			if (box) onResizeRef.current(Math.round(box.width), Math.round(box.height));
		});
		observer.observe(stage);
		return () => observer.disconnect();
	}, []);
	const [ripples, setRipples] = useState<readonly Ripple[]>([]);
	const lastHoverRef = useRef(0);
	const rippleIdRef = useRef(0);
	const live = mode === "live" && frame !== null;

	const liveRef = useRef(live);
	liveRef.current = live;
	const viewportRef = useRef(viewport);
	viewportRef.current = viewport;
	const onActionRef = useRef(onAction);
	onActionRef.current = onAction;

	const pointAt = (clientX: number, clientY: number): Point | null => {
		const page = pageRef.current;
		if (!page) return null;
		return toViewportPoint(page.getBoundingClientRect(), clientX, clientY, viewport);
	};

	const ripple = (event: ReactMouseEvent, kind: Ripple["kind"]) => {
		const page = pageRef.current;
		if (!page) return;
		const box = page.getBoundingClientRect();
		const id = ++rippleIdRef.current;
		setRipples(current => [...current.slice(-4), { id, x: event.clientX - box.left, y: event.clientY - box.top, kind }]);
		window.setTimeout(() => setRipples(current => current.filter(entry => entry.id !== id)), 600);
	};

	const click = (event: ReactMouseEvent, button: "left" | "right" | "middle") => {
		if (!live) return;
		const point = pointAt(event.clientX, event.clientY);
		if (point === null) return;
		const pixel = toPixelPoint(point, viewport);
		const clickCount = Math.min(3, Math.max(1, event.detail)) as 1 | 2 | 3;
		ripple(event, button);
		onAction(button === "left" && clickCount === 1 ? { kind: "click", x: pixel.x, y: pixel.y } : { kind: "click", x: pixel.x, y: pixel.y, button, clickCount });
	};

	// Wheel must be a non-passive native listener to stop the seat scrolling.
	useEffect(() => {
		const page = pageRef.current;
		if (!page) return;
		const onWheel = (event: WheelEvent) => {
			// Wheel over a floating layer (agent steps, a toast) scrolls that layer.
			if (!liveRef.current || (event.target instanceof Element && event.target.closest(".bx-floats") !== null)) return;
			event.preventDefault();
			const box = page.getBoundingClientRect();
			const current = viewportRef.current;
			// Seat pixels → viewport pixels, so the page moves under the hand 1:1.
			const scale = box.width > 0 ? current.width / box.width : 1;
			const unit = event.deltaMode === 1 ? WHEEL_LINE_PX : event.deltaMode === 2 ? current.height : 1;
			const deltaX = Math.round((event.shiftKey && event.deltaX === 0 ? event.deltaY : event.deltaX) * unit * scale);
			const deltaY = Math.round((event.shiftKey && event.deltaX === 0 ? 0 : event.deltaY) * unit * scale);
			if (deltaX === 0 && deltaY === 0) return;
			onActionRef.current({ kind: "scroll", deltaX, deltaY });
		};
		page.addEventListener("wheel", onWheel, { passive: false });
		return () => page.removeEventListener("wheel", onWheel);
	}, [frame === null]);

	const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
		if (!live || event.pointerType !== "mouse" || event.buttons !== 0) return;
		const now = performance.now();
		if (now - lastHoverRef.current < HOVER_INTERVAL_MS) return;
		lastHoverRef.current = now;
		const point = pointAt(event.clientX, event.clientY);
		if (point === null) return;
		const pixel = toPixelPoint(point, viewport);
		onAction({ kind: "hover", x: pixel.x, y: pixel.y });
	};

	const onPointerDown = () => {
		pageRef.current?.focus({ preventScroll: true });
	};

	const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
		if (!live || event.ctrlKey || event.metaKey || event.altKey) return;
		// Shift+Tab is left to the host: it is the way out of the page for a keyboard user.
		if (event.key === "Tab" && event.shiftKey) return;
		if (confirming && (event.key === "Tab" || event.key === "Enter")) return;
		if (event.key === " ") {
			event.preventDefault();
			onAction({ kind: "press", key: "Space" });
			return;
		}
		if (NAMED_KEYS[event.key]) {
			event.preventDefault();
			onAction({ kind: "press", key: event.key });
			return;
		}
		if ([...event.key].length === 1) {
			event.preventDefault();
			onAction({ kind: "insert", text: event.key });
		}
	};

	const onPaste = (event: ReactClipboardEvent<HTMLDivElement>) => {
		if (!live) return;
		const text = event.clipboardData.getData("text/plain");
		if (text.length === 0) return;
		event.preventDefault();
		onAction({ kind: "insert", text: text.slice(0, 4096) });
	};

	const style = { "--vw": viewport.width, "--vh": viewport.height } as CSSProperties;

	return (
		<div className="bx-stage" data-mode={mode} ref={stageRef}>
			<div
				ref={pageRef}
				className="bx-page"
				style={style}
				role="application"
				tabIndex={0}
				aria-roledescription="web page"
				aria-label={
					mode === "frozen"
						? `${label}. Capturing the page for marking.`
						: mode === "locked"
							? `${label}. An agent is driving this page.`
							: confirming
								? `${label}. A post is waiting for your confirmation: Tab moves to it. Click, scroll and type to use the page.`
								: `${label}. Click, scroll and type to use the page. Shift+Tab leaves it.`
				}
				onPointerDown={onPointerDown}
				onPointerMove={onPointerMove}
				onClick={event => click(event, "left")}
				onAuxClick={event => {
					if (event.button === 1) click(event, "middle");
				}}
				onMouseDown={event => {
					// Middle-button autoscroll belongs to the page, not the seat.
					if (event.button === 1) event.preventDefault();
				}}
				onContextMenu={event => {
					event.preventDefault();
					click(event, "right");
				}}
				onKeyDown={onKeyDown}
				onPaste={onPaste}
			>
				{frame === null ? (
					<div className="bx-page-skeleton" aria-hidden="true" />
				) : (
					<img
						className="bx-frame"
						src={`data:${frame.mimeType};base64,${frame.data}`}
						width={viewport.width}
						height={viewport.height}
						alt=""
						draggable={false}
						decoding="sync"
					/>
				)}
				{ripples.map(entry => (
					<span key={entry.id} className="bx-ripple" data-kind={entry.kind} style={{ left: entry.x, top: entry.y }} aria-hidden="true" />
				))}
				{children !== undefined && <Overlays>{children}</Overlays>}
			</div>
		</div>
	);
}

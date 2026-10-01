// PowerPoint decks, drawn by @aiden0z/pptx-renderer (Apache-2.0; 1.1 MB minified,
// 342 KB gzip in this pack's build, ECharts and JSZip inside). Best overall fidelity
// of the four candidates in `docs/design/84-chat-viewer-research.md` § Measured: the
// only one that drew every slide, chart, table and layout-centred title on both a
// pptxgenjs and a python-pptx deck. Known miss: a pptxgenjs chart loses its category
// labels.
//
// One slide at a time: `pageCount` is the slide count and `goto(n)` shows slide n.
// The pane's own keys (arrows, Page Up/Down, Home/End) move too and say so through
// `ctx.onPage`, so the toolbar's counter follows. The library renders SVG/HTML
// through `createElement`/`textContent` (its one `innerHTML` writes escaped text);
// each slide it draws is still passed through `neutralizeTree` before it can be
// clicked, because a text hyperlink is set as a real `href`. A clickable SHAPE or
// picture is different: the viewer routes its click to `window.open`, which the
// View's sandbox would allow. Version 1.3.0 has no option for that (its
// `onNavigate` exists only on the internal render context), so the router is
// replaced on the instance; see `routeLinks`.
//
// Offline by construction: `pdfjs: false` turns off the only optional network-ish
// path (EMF-embedded PDF previews, which would import pdf.js and start a worker).

import { PptxViewer, RECOMMENDED_ZIP_LIMITS } from "@aiden0z/pptx-renderer";
import { clampZoom, mountOffice, neutralizeTree, POWERPOINT, ProblemError, wireLinks, ZIP_LIMITS } from "./office/shared";
import type { Mounted, MountContext, Renderer } from "./types";

/** How a key moves through the deck; Home and End are handled apart. */
const KEY_STEP: Record<string, number> = {
	ArrowRight: 1,
	ArrowDown: 1,
	PageDown: 1,
	ArrowLeft: -1,
	ArrowUp: -1,
	PageUp: -1,
};

/** The viewer's link router. Private in 1.3.0's typings, and looked up on the
 *  instance at every click, which is why replacing it works. */
interface LinkRouter {
	handleNavigate(target: { slideIndex?: number; url?: string }): void;
}

/**
 * Send a shape's or picture's link where the pane wants it: another slide keeps
 * the library's own behaviour, http(s) goes to the host through `ctx.openLink`,
 * and everything else (mailto, javascript:, a relative path) is dropped. If a
 * newer library no longer has the router this fails the mount: an upgrade must
 * not quietly bring `window.open` back.
 */
function routeLinks(viewer: PptxViewer, ctx: MountContext): void {
	const router = viewer as unknown as LinkRouter;
	if (typeof router.handleNavigate !== "function") {
		viewer.destroy();
		throw new Error("The presentation library no longer routes links through handleNavigate; pptx.ts must be updated before it is upgraded.");
	}
	const toSlide = router.handleNavigate.bind(viewer);
	router.handleNavigate = target => {
		if (target.slideIndex !== undefined) toSlide({ slideIndex: target.slideIndex });
		else if (target.url !== undefined && /^https?:\/\//i.test(target.url)) ctx.openLink?.(target.url);
	};
}

async function mountPptx(root: HTMLElement, bytes: Uint8Array, ctx: MountContext): Promise<Mounted> {
	const doc = root.ownerDocument;
	root.tabIndex = 0;
	const scroll = doc.createElement("div");
	scroll.className = "vo-scroll vo-slides";
	const host = doc.createElement("div");
	host.className = "vo-slide-host";
	// The annotation layer finds the rendered text through this slot; one slide is in the DOM at a time.
	host.dataset.slot = "viewer-text-root";
	scroll.append(host);
	root.append(scroll);

	const viewer = await PptxViewer.open(bytes, host, {
		renderMode: "slide",
		fitMode: "contain",
		zipLimits: { ...RECOMMENDED_ZIP_LIMITS, ...ZIP_LIMITS },
		lazySlides: true,
		lazyMedia: true,
		pdfjs: false,
		onSlideRendered: (index, slide) => {
			slide.dataset.pageNumber = String(index + 1);
			neutralizeTree(slide);
		},
	});
	routeLinks(viewer, ctx);
	const pageCount = viewer.slideCount;
	if (pageCount === 0) {
		viewer.destroy();
		throw new ProblemError({ title: "This presentation has no slides", detail: "There is nothing to show." });
	}
	const unwireLinks = wireLinks(host, ctx);

	const show = (page: number): void => {
		void viewer.goToSlide(Math.min(pageCount, Math.max(1, Math.trunc(page))) - 1);
	};
	const onKey = (event: KeyboardEvent): void => {
		const current = viewer.currentSlideIndex + 1;
		const step = Object.hasOwn(KEY_STEP, event.key) ? KEY_STEP[event.key] : 0;
		const next = event.key === "Home" ? 1 : event.key === "End" ? pageCount : current + step;
		if (next === current || next < 1 || next > pageCount) return;
		event.preventDefault();
		show(next);
		ctx.onPage?.(next);
	};
	root.addEventListener("keydown", onKey);

	return {
		destroy: () => {
			root.removeEventListener("keydown", onKey);
			unwireLinks();
			viewer.destroy();
		},
		zoom: factor => {
			void viewer.setZoom(clampZoom(factor) * 100);
		},
		pageCount,
		goto: show,
	};
}

const renderer: Renderer = {
	mount: (el, bytes, ctx) => mountOffice(el, bytes, ctx, POWERPOINT, root => mountPptx(root, bytes, ctx)),
};

export default renderer;

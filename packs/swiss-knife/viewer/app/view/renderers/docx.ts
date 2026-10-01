// Word documents, drawn by docx-preview (Apache-2.0; 49 KB gzip in this pack's build,
// docx-preview 21 KB + JSZip 28 KB; the measurements are in
// `docs/design/84-chat-viewer-research.md` § Measured).
//
// The document is untrusted markup made by someone else, so it renders into a
// SHADOW ROOT inside a CONTAINMENT BOX. What each one guarantees, exactly:
//   - The shadow root scopes the library's output. docx-preview writes a `<style>`
//     built from the file's own style and font names WITHOUT escaping them, so a
//     crafted font name can close its declaration and add rules of its own. Those
//     rules match only inside the shadow tree, with one exception: `:host` selects
//     the host element, which sits in the pane, so `:host{position:fixed;inset:0;
//     z-index:9999}` would cover the whole View. The shadow root alone does not stop that.
//   - The containment box (`.vo-docx-guard`, styled INLINE so no stylesheet in the
//     shadow tree can reach it) does. `contain: paint` makes the box the containing
//     block of every `position: fixed` descendant and clips all painting to it,
//     `overflow: hidden` says the same to engines that ignore paint containment, and
//     `isolation: isolate` keeps any `z-index` inside. A hostile stylesheet can
//     therefore cover, hide or scramble the document's OWN pages and nothing outside the box.
//   - Not guaranteed: how the document looks, or what its CSS may fetch, which is
//     bounded by the frame's Content-Security-Policy, not by this file.
// The library builds its DOM with `createElement`/`textContent`, but it copies each
// hyperlink's target straight into `href`, so the tree is still passed through
// `neutralizeTree` (links lose their `href`; http(s) targets go to `ctx.openLink`).
//
// The page is paper: white with black ink on both themes. Only the backdrop and
// the scroll bars follow the host theme.

import { renderAsync } from "docx-preview";
import { clampZoom, mountOffice, neutralizeTree, WORD, wireLinks } from "./office/shared";
import type { Mounted, MountContext, Renderer } from "./types";

/** docx-preview writes `.docx-wrapper{background:gray;…}`; this is appended after
 *  it so the backdrop is the host's surface and the ink is black on paper. */
const PAPER_CSS = `
:host{display:block}
.docx-wrapper{background:transparent;padding:16px 16px 0}
.docx-wrapper>section.docx{color:var(--vo-ink);box-shadow:0 0 0 1px var(--fr-border)}
`;

/** The box is as wide as the widest page (never narrower than the pane), so a page
 *  zoomed past the pane scrolls the pane instead of being clipped by the box. */
const GUARD_STYLE = "contain:paint;overflow:hidden;isolation:isolate;width:max-content;min-width:100%";

/** Gap kept either side of a page when it is scaled to fit the pane. */
const FIT_MARGIN = 16;

async function mountDocx(root: HTMLElement, bytes: Uint8Array, ctx: MountContext): Promise<Mounted> {
	const doc = root.ownerDocument;
	const scroll = doc.createElement("div");
	scroll.className = "vo-scroll";
	const guard = doc.createElement("div");
	guard.className = "vo-docx-guard";
	guard.setAttribute("style", GUARD_STYLE);
	const host = doc.createElement("div");
	guard.append(host);
	scroll.append(guard);
	root.append(scroll);

	// The annotation layer finds the rendered text through this slot; it reads the open shadow root itself.
	host.dataset.slot = "viewer-text-root";
	const shadow = host.attachShadow({ mode: "open" });
	const libraryStyles = doc.createElement("div");
	const body = doc.createElement("div");
	const paperStyles = doc.createElement("style");
	paperStyles.textContent = PAPER_CSS;
	shadow.append(libraryStyles, body, paperStyles);

	await renderAsync(bytes, body, libraryStyles, {
		className: "docx",
		inWrapper: true,
		breakPages: true,
		ignoreLastRenderedPageBreak: true,
		// A blob: URL per image would outlive the pane, and `renderAltChunks` draws an
		// embedded HTML document into an <iframe>: neither belongs in a viewer.
		useBase64URL: true,
		renderAltChunks: false,
		experimental: false,
	});
	neutralizeTree(shadow);
	const unwireLinks = wireLinks(shadow, ctx);

	const pages = Array.from(body.querySelectorAll<HTMLElement>("section.docx"));
	let factor = 1;
	let fit = 1;

	const apply = (): void => {
		host.style.zoom = String(fit * factor);
	};
	// A page is a fixed width (Letter is 816 px); a pane narrower than that scales
	// it down to fit rather than scrolling sideways. `zoom(1)` means "fitted".
	const refit = (): void => {
		const pageWidth = pages[0]?.offsetWidth ?? 0;
		const paneWidth = scroll.clientWidth;
		fit = pageWidth > 0 && paneWidth > 0 ? Math.min(1, (paneWidth - 2 * FIT_MARGIN) / pageWidth) : 1;
		fit = Math.max(0.25, fit);
		apply();
	};
	refit();
	const resize = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(refit);
	resize?.observe(scroll);

	// The pager exists only when the file itself breaks pages or sections; docx-preview
	// does not paginate flowing text, so a long single-section file has no honest page count.
	let current = 1;
	const onScroll = (): void => {
		const top = scroll.getBoundingClientRect().top + scroll.clientHeight / 3;
		let page = 1;
		for (let index = 0; index < pages.length; index++) {
			if (pages[index].getBoundingClientRect().top <= top) page = index + 1;
		}
		if (page === current) return;
		current = page;
		ctx.onPage?.(page);
	};
	if (pages.length > 1) scroll.addEventListener("scroll", onScroll, { passive: true });

	return {
		destroy: () => {
			resize?.disconnect();
			scroll.removeEventListener("scroll", onScroll);
			unwireLinks();
		},
		zoom: next => {
			factor = clampZoom(next);
			apply();
		},
		...(pages.length > 1
			? {
					pageCount: pages.length,
					goto: (page: number) => {
						current = Math.min(pages.length, Math.max(1, Math.trunc(page)));
						pages[current - 1].scrollIntoView({ block: "start" });
					},
				}
			: {}),
	};
}

const renderer: Renderer = {
	mount: (el, bytes, ctx) => mountOffice(el, bytes, ctx, WORD, root => mountDocx(root, bytes, ctx)),
};

export default renderer;

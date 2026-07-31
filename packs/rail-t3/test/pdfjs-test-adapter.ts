// Bun treats Vite's `?url` worker import as the worker module, which has no
// default export. Fraym's own test adapter mocks the pdfjs specifiers, but a
// specifier mock only matches when it resolves to the SAME copy — and from this
// pack, `pdfjs-dist` resolves to the superproject's hoisted copy while
// `@fraym/ui`'s sources import fraym's own store. So the boundary is drawn one
// module higher: stub the ONE component that imports the worker. Browser builds
// still use Vite's asset transformation; this only gives Bun tests an inert PDF
// boundary.
import { mock } from "bun:test";

mock.module("../../../../fraym/packages/ui/src/features/file-view/pdf-view.tsx", () => ({
	PdfView: () => null,
}));

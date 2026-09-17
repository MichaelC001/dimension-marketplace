export { footerLine, parseLinkInput, refKey, relativeTime } from "./model";
export { PrViewer, type PrViewerProps } from "./pr-viewer";

// The bundle contract (doc 68 §16.2): the host loads `dist/index.mjs` and
// takes its DEFAULT export as the component. Named exports stay for in-tree
// and test importers.
export { PrViewer as default } from "./pr-viewer";

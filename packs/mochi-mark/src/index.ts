export { MochiMark } from "./mochi-mark";

// The bundle contract (doc 68 §16.2): the host loads `dist/index.mjs` and
// takes its DEFAULT export as the component. Named exports stay for in-tree
// and test importers.
export { MochiMark as default } from "./mochi-mark";

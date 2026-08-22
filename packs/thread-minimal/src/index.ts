export { MinimalThread, type MinimalThreadProps } from "./thread-minimal";

// The bundle contract (doc 68 §16.2): the host loads `dist/index.mjs` and
// takes its DEFAULT export as the component. Named exports stay for in-tree
// and test importers.
export { MinimalThread as default } from "./thread-minimal";

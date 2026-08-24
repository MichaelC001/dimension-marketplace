export { MinimalComposer, type MinimalComposerProps } from "./composer-minimal";

// The bundle contract (doc 68 §16.2): the host loads `dist/index.mjs` and
// takes its DEFAULT export as the component.
export { MinimalComposer as default } from "./composer-minimal";

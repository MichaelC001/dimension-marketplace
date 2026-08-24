export { MinimalEnvironment, type MinimalEnvironmentProps } from "./env-minimal";

// The bundle contract (doc 68 §16.2): the host loads `dist/index.mjs` and
// takes its DEFAULT export as the component.
export { MinimalEnvironment as default } from "./env-minimal";

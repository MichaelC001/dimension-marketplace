export type { T3Partition, T3Row, T3Status } from "./partition";
export { partitionSessions, t3Status } from "./partition";
export { T3_RAIL, T3Rail } from "./t3-rail";

// The bundle contract (doc 68 §16.2): the host loads `dist/index.mjs` and
// takes its DEFAULT export as the component. Named exports stay for in-tree
// and test importers.
export { T3Rail as default } from "./t3-rail";

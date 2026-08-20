export { type BoardPartition, type BoardRow, type BoardSession, partitionBoard } from "./partition";
export { SessionBoard, type SessionBoardProps } from "./session-board";

// The bundle contract (doc 68 §16.2): the host loads `dist/index.mjs` and
// takes its DEFAULT export as the component. Named exports stay for in-tree
// and test importers.
export { SessionBoard as default } from "./session-board";

// Classic Workspace Host — the workspace host — the pane container with splits, tiling, chat-presence backdrop and room overlays.
//
// The whole pack is a RE-EXPORT. `@fraym/ui` is a granted pack external (the
// same lane React rides), so a pack does not have to reimplement a shipped
// surface to contribute it: it ships the product's own component, installed
// from the marketplace rather than compiled in. That is the difference between
// an assembled space and a lookalike — there is no second implementation here
// to drift, degrade, or approximate.
//
// The center pane. Before this pack no marketplace part had ever filled the `workspace` contract, so every space fell through to the shipped host.
import { HOST_SPLITS } from "@fraym/ui";

/** The bundle contract (doc 68 §16.2): the host takes the DEFAULT export. */
export default HOST_SPLITS.component;
export { HOST_SPLITS as implementation };

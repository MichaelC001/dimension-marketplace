// Classic Dock — the dock COLUMN — the tab strip, the resize handle, the panel body.
//
// The whole pack is a RE-EXPORT. `@fraym/ui` is a granted pack external (the
// same lane React rides), so a pack does not have to reimplement a shipped
// surface to contribute it: it ships the product's own component, installed
// from the marketplace rather than compiled in. That is the difference between
// an assembled space and a lookalike — there is no second implementation here
// to drift, degrade, or approximate.
//
// Fills the `dock-column` contract, NOT `dock`: a component declaring `dock` is an instrument (one tab). This is the column those tabs live in.
import { DOCK_CLASSIC } from "@fraym/ui";

/** The bundle contract (doc 68 §16.2): the host takes the DEFAULT export. */
export default DOCK_CLASSIC.component;
export { DOCK_CLASSIC as implementation };

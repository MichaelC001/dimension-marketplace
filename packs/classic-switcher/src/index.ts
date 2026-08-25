// Classic Switcher — the space switcher rail — the far-left column of space marks.
//
// The whole pack is a RE-EXPORT. `@fraym/ui` is a granted pack external (the
// same lane React rides), so a pack does not have to reimplement a shipped
// surface to contribute it: it ships the product's own component, installed
// from the marketplace rather than compiled in. That is the difference between
// an assembled space and a lookalike — there is no second implementation here
// to drift, degrade, or approximate.
//
// The switcher is app chrome (the shell mounts one regardless), but its FILL is a normal registered contract, so it is packable like the rest.
import { SWITCHER_RAIL } from "@fraym/ui";

/** The bundle contract (doc 68 §16.2): the host takes the DEFAULT export. */
export default SWITCHER_RAIL.component;
export { SWITCHER_RAIL as implementation };

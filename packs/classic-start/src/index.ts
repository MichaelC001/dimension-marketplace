// the session surface's FRONT DOOR — the hero composer, the Project · Work
// strip, the two menus and the placed-widget spacer, shipped AS A PACK.
//
// There is no reimplementation here, and that is the point. `START_CLASSIC` is
// published on the host's EXTERNALS contract (`host-externals.ts`), so this
// pack's contribution is the REAL component — identical pixels, identical
// behaviour, identical contract — delivered through the marketplace instead of
// compiled into the shell. A lookalike would be worse than absent: the shipped
// surface's composer carries the draft + outbox awareness that lets a FIRST
// send survive a reload (doc 64 §5.5), and a hand-rolled hero would silently
// drop it.
//
// What this pack does NOT carry is the hero SENTENCE. That is product copy, so
// it comes from the space definition (`workspace.startCopy.heading`, its
// `{workspace}` token resolved by the seat) — the kit hardcoded it until Phase
// 1 slice 6, which made the line unreachable from any space.
import { START_CLASSIC } from "@fraym/ui";

export const implementation = START_CLASSIC;

/** The bundle contract (doc 68 §16.2): the host takes the default export. */
export default START_CLASSIC.component;

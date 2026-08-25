// the session surface's thread section, shipped AS A PACK.
//
// There is no reimplementation here, and that is the point. `THREAD_CLASSIC` is
// published on the host's EXTERNALS contract (`host-externals.ts`), so this
// pack's contribution is the REAL component — identical pixels, identical
// behaviour, identical contract — delivered through the marketplace instead of
// compiled into the shell.
//
// PROVEN, not assumed: a wrapper carrying `data-probe-pack="classic-thread"` was built
// into this bundle and the marker appeared in the assembled space's DOM while
// being absent from the built-in Code space. Before the externals contract
// published these implementations, this same import resolved to a module that
// did not export it — the named import threw at `import()`, the load rejected,
// and the slot fell back to the built-in with no visible symptom.
import { THREAD_CLASSIC } from "@fraym/ui";

export const implementation = THREAD_CLASSIC;

/** The bundle contract (doc 68 §16.2): the host takes the default export. */
export default THREAD_CLASSIC.component;

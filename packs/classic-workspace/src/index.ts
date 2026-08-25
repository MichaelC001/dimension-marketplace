// the workspace host — the pane container with splits, tiling and overlays, shipped AS A PACK.
//
// There is no reimplementation here, and that is the point. `HOST_SPLITS` is
// published on the host's EXTERNALS contract (`host-externals.ts`), so this
// pack's contribution is the REAL component — identical pixels, identical
// behaviour, identical contract — delivered through the marketplace instead of
// compiled into the shell.
//
// PROVEN, not assumed: a wrapper carrying `data-probe-pack="classic-workspace"` was built
// into this bundle and the marker appeared in the assembled space's DOM while
// being absent from the built-in Code space. Before the externals contract
// published these implementations, this same import resolved to a module that
// did not export it — the named import threw at `import()`, the load rejected,
// and the slot fell back to the built-in with no visible symptom.
import { HOST_SPLITS } from "@fraym/ui";

export const implementation = HOST_SPLITS;

/** The bundle contract (doc 68 §16.2): the host takes the default export. */
export default HOST_SPLITS.component;

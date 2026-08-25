// Classic Composer — the session surface's composer section, shipped AS A PACK.
//
// There is no reimplementation here, and that is the entire point. The shipped
// implementation is exported from `@fraym/ui` (a granted pack external), so this
// pack's contribution is the REAL component — identical pixels, identical
// behaviour, identical contract — delivered through the marketplace instead of
// hardcoded into the shell. A space that binds this is assembled, not
// approximated: the difference between "looks like the product" and "is the
// product, installed".
//
// The reduced `*-minimal` packs prove a DIFFERENT thing (that the contract can
// carry a stranger's part at the zero-import floor). This proves the contract
// can carry the product itself.
import { COMPOSER_CLASSIC } from "@fraym/ui";

export const implementation = COMPOSER_CLASSIC;

/** The bundle contract (doc 68 §16.2): the host takes the default export. */
export default COMPOSER_CLASSIC.component;

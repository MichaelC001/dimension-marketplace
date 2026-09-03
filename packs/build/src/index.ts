// Build is a LAYOUT plugin: its whole contribution is DATA - four slots and a
// space whose every filling is bound to a pack that ships the REAL component.
// Zero pixels, zero runtime, no reimplementation anywhere in the chain.
//
// What this space is FOR: it is the assembled workspace. Everything the Code
// space draws - rail, thread, composer, start surface, dock, environment card,
// switcher - arrives here as a marketplace pack rather than compiled-in code,
// so any one of them can be swapped for another pack without touching the app.
//
// It stands BESIDE the built-in Code space rather than replacing it, and the
// two being indistinguishable is the point: a visible difference is a hole in
// the assembly contract, and naming that hole is the deliverable.
export {};

// Forge is a LAYOUT plugin: its whole contribution is DATA in
// `dimension.plugin.json` — four slots and the Forge space that assembles on
// them (doc 68 §4.1, doc 69 §3). There is deliberately no runtime here: a
// layout is topology, ZERO pixels, and it ships no code.
//
// Every filling Forge names comes from another pack: rail-t3 (rail),
// session-board (dock), mochi-mark (badge), thread-minimal + composer-minimal
// (the session surface's two sections) and env-minimal (a pinned widget). The
// exception is stated in the manifest's own description — `forge-main` has no
// contributed workspace component to name, so it resolves to the shell's
// default. That gap is the point: it is what this space measures.
export {};

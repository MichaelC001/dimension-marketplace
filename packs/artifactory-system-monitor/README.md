# System Monitor — an example artifactory

The second Phase 4 pilot (doc 45 §8): the reference
`@modelcontextprotocol/server-system-monitor` from modelcontextprotocol/ext-apps,
byte-for-byte, packaged as a Dimension plugin. Beyond the three.js pilot it
proves two more spec paths live: an APP-ONLY tool (`poll-system-stats`,
`visibility: ["app"]`) the model never sees, and a View that calls it —
which is the call the engine's consent gate decides. What it decides depends on
WHERE THE ENGINE LOADED the pack, never on a name (dimension#1055; the rule is
`isFirstPartyStoreEntry` in the engine's `native/marketplace-facade.ts`): only
a pack the desktop installer bundles, or a dev link into the engine's own
`packages/` or `traction/packs/`, is first-party and pre-approved. This pack is
neither. It ships from this shelf, and a store install is third-party
whatever the shelf calls itself, so `poll-system-stats` prompts once per tool
("Allow this app to run Poll System Stats?") until the user answers "always".
That is also true when it is dev-linked from `marketplace/packs/`. The live
proof of the prompt ran the pack as third-party.

Packaging only: `.mcp.json` names the server, `dimension.plugin.json` names it
as an artifactory, `server.mjs` starts the reference CLI over stdio.

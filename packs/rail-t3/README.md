# T3 Rail (`rail-t3`)

A T3-Code-style session rail: urgency-partitioned sessions (**live** cards /
**quiet** rows / a **settled** shelf), repo group chips, and the full rail duty
set — a production alternative to the shell's own `rail-classic`, assembled by
name instead of compiled in.

This pack is the **worked example of the in-tree component tier** (doc 68 §5):
it needs live host power (icons, surface routing), so it imports real values —
and exactly which values is the point.

## The three declarations

A component ships as data + code + (optionally) an assembly that uses it:

1. **`dimension.plugin.json`** — the declaration the engine validates at load
   (`validateComponentDecl`, the same call `@dimension/sdk/component` exports):

   ```json
   { "plugin": "rail-t3", "type": "component", "slot": "rail" }
   ```

   `slot: "rail"` is the WELL-KNOWN convention name; compatibility with any
   layout is derived from that name (doc 68 §4.4), never listed per-layout.

2. **The module map entry** — code does not load itself. The consuming app
   enumerates component modules (`apps/web/src/main.tsx`):

   ```ts
   componentModules: { "rail-t3": T3Rail }
   ```

   Static import, so what a contributed part may reach is exactly what its
   module imports — the externals contract, enforced by the bundler.

3. **A space that assembles it** — Demo Lane (`packs/three-lane`) binds
   `components: { "lane-left": "rail-t3", "badge": "mochi-mark" }`. It honors
   the three-lane layout's own slots: `lane-left` (the rail seat the geography
   resolver honors) is filled with this component's `rail-t3`, and the mark
   seat with another plugin's `mochi-mark`.

## The import surface — a contract, not a convenience

```
react                          — the floor (every tier)
@fraym/ui: cn, Icon, SURFACE   — the in-tree tier's THREE granted values
@fraym/ui: 7 type imports      — erased at compile; free at every tier
```

This set settled doc 68 §9.1 Q1 (2026-08-19): each `@fraym/ui` VALUE a
component imports is a permanent capability grant the platform must support
forever. Adding one to this list is a review event. A component that needs no
live values at all should target the zero-import tier instead (see
`pulse-mark`: bare `useSyncExternalStore` over the Store's contract shape).

## Tests

- `test/rail-duties.test.tsx` — the conformance suite, driven through the
  host's own `mountForTest` + `railSlotFixture` (9 tests: selection, context
  menus, intent emission, group switching, empty state).
- `test/partition.test.ts` — the pure session-partition model.
- `test/vendored-types.test.ts` — proves the pack typechecks STANDALONE
  against `types/fraym-ui.d.ts` (no monorepo required).
- `packages/space-sdk/test/rail-t3-manifest.test.ts` (monorepo side) — the
  manifest passes the engine's validation; Demo Lane's bindings resolve.

`types/fraym-ui.d.ts` is generated (`types/README.md` has the regeneration
command); it gives *authorability* outside the monorepo, not installability —
runtime `@fraym/ui` still arrives from the consuming app.

## Status

Registered through the ONE slot-component registry (`slotComponents`) via the
standard contribution loader. The legacy `RailImplementation` export
(`T3_RAIL`) survives for the two legacy seats that still cycle it (the holding
page and the Space Designer's static catalogue); it dies with them.

## Build

`bun run build` (vite lib mode) emits `dist/index.mjs` — the ESM bundle the
host loads at runtime, externalising exactly `react`, `react-dom`,
`react/jsx-runtime`, `@fraym/ui`. `dist/` is **committed**: a pack must be
installable with no build step.

The bundle's **default export is the component** (`T3Rail`) — that is the
loader's whole contract; the named exports stay for in-tree and test importers.

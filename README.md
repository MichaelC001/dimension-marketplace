# dimension-marketplace

The public marketplace for the **Dimension** platform: community components,
layouts, instruments, artifactories and spaces.

Dimension's UI is assembled from **slots**. The slot set is **open and
layout-owned** (doc 68 §4.1): a layout plugin declares its own slots;
well-known names (`rail · dock · workspace · thread · composer · mark`) are
platform-published *conventions*, not a closed law. This repository is where
the fillings live: anyone can ship a rail, a mark, a dock instrument, a
layout, or a whole space, and Dimension installs it as a plugin.

## What lives here

```
packs/
  rail-t3/        A T3-Code-style session rail — a production alternative to
                  rail-classic. The IN-TREE tier's worked example: its import
                  surface (react + cn/Icon/SURFACE from @fraym/ui) settled
                  the externals contract.
  session-board/  Sessions — mission control in the dock. The first
                  contributed INSTRUMENT (the fourteenth contribution type),
                  at the zero-import floor: react only, facts from the Store.
  three-lane/     A LAYOUT declaring its own slots, shipping Demo Lane — the
                  assembly-spine thesis demo (three plugins, nobody hand-wired).
  mochi-mark/     A mark component: the import-surface FLOOR (react only).
  pulse-mark/     The Store's demo mark: zero Fraym UI, one granted binding.
.omp-plugin/
  marketplace.json  The catalog Dimension's plugin system reads.
```

Each pack declares itself in ONE file — `dimension.plugin.json` — validated by
the engine at plugin load with the same pure validators `@dimension/sdk`
re-exports (`validateComponentDecl`, `validateLayoutDef`,
`validateInstrumentDecl`, `validateSpaceDefs`). The full authoring walkthrough
lives in the Dimension repository: `docs/guides/building-a-custom-space.md`.

## The three tiers, by import surface

| Tier | Import surface | Worked example |
|---|---|---|
| **Zero-import floor** | `react` only — the Store arrives as a prop/context value; styling on the host's `--fr-*` custom properties | `pulse-mark`, `session-board` |
| **In-tree** | `react` + enumerated `@fraym/ui` VALUES (each one a permanent capability grant, settled per component) | `rail-t3` (`cn`, `Icon`, `SURFACE`) |
| **Sandboxed** | zero imports — the wire is the contract (MCP Apps transport; platform Phase 4) | artifactory packs |

## How a pack gets in

1. **Declare it.** `dimension.plugin.json` with `"type": "component"` (+ `slot`),
   `"type": "layout"` (+ `slots`), `"type": "instrument"`, or `spaces`.
2. **Build against the published surface.** Facts come from the Store's
   published key table (`catalogue.json` in the Dimension repo — typed via
   `readFact`/`watchFact`); pixels are yours, drawn on `--fr-*` design tokens
   (house rule: tokens only, color-is-meaning stays the host's).
3. **Pass the gates.** The engine's decl validation (a manifest test in the
   monorepo pins it), your pack's own tests, and — for well-known slots — the
   conformance suite (`mountForTest` + per-slot fixtures; rail-t3's
   `rail-duties.test.tsx` is the reference).
4. Open a PR adding your pack under `packs/` plus a catalog entry in
   `.omp-plugin/marketplace.json`. Review + green gates = merged = published.

See [CONTRIBUTING.md](CONTRIBUTING.md).

## Status and honesty

- Packs currently consume the platform as workspace dependencies, so they
  build inside the Dimension monorepo (this repo is mounted there as the
  `marketplace/` checkout, and the monorepo CI runs each pack's tests).
  `@dimension/sdk` ships workspace-private until the marketplace-launch slice
  adds the publish lane; rail-t3's vendored `types/fraym-ui.d.ts` shows the
  standalone-authoring path in the meantime.
- Runtime installation of UI component packs into the shipped app awaits the
  platform's execution-tier work (doc 68 Phase 4): today a pack's CODE is
  enumerated in the consuming app's module map (`componentModules`), which is
  the deliberate externals-contract seam, not a temporary hack. Artifactory
  packs already install and run sandboxed.

## Using the marketplace

From a Dimension session:

```
plugins op:add-marketplace name:dimension-marketplace source:insodimension/dimension-marketplace
plugins op:catalog marketplace:dimension-marketplace
plugins op:install name:rail-t3 marketplace:dimension-marketplace
```

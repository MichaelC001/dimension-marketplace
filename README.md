# dimension-marketplace

The public marketplace for the **Dimension** platform: community components,
instruments, artifactories and spaces. Contracts closed, implementations open.

Dimension's UI is assembled from slots (rail, workspace, dock) whose contracts
are fixed and whose fillings are an open set. This repository is where the open
set lives: anyone can ship a rail, a dock instrument, an artifactory or a whole
space, and Dimension installs it as a plugin.

## What lives here

```
packs/
  rail-t3/        A T3-Code-style session rail. Implementation #2 of the rail
                  contract, and the reference for how a pack is built.
.omp-plugin/
  marketplace.json  The catalog Dimension's plugin system reads.
```

Each pack is a standard package built against Dimension's public contracts
(`RailSlotProps` and friends). The full authoring walkthrough lives in the
Dimension repository: `docs/guides/building-a-custom-space.md`.

## How a pack gets in

1. Build against the contract. The contract types and the conformance kit
   (`mountForTest`, per-slot fixtures, the slot duties) are the public surface.
2. Pass the conformance suite for your slot kind. A rail must render every
   enabled action, emit the documented ShellIntents, keep exactly one primary
   action, and match active state by surface identity. The suite is the
   quality gate, not a style opinion.
3. Open a PR adding your pack under `packs/` plus a catalog entry in
   `.omp-plugin/marketplace.json`. Review + green conformance = merged =
   published.

See [CONTRIBUTING.md](CONTRIBUTING.md).

## Status and honesty

- Packs currently consume `@fraym/ui` as a workspace dependency, so they build
  inside the Dimension monorepo (this repo is mounted there as the
  `marketplace/` submodule, and the monorepo CI runs each pack's tests). A
  published contracts package that lets packs build fully standalone is the
  platform's tracked next step (Dimension doc 56, section 3.3.1).
- Runtime installation of UI component packs into the shipped app awaits the
  platform's execution-tier ruling (same doc). Artifactory packs already
  install and run sandboxed today.

## Using the marketplace

From a Dimension session:

```
plugins op:add-marketplace name:dimension-marketplace source:insodimension/dimension-marketplace
plugins op:catalog marketplace:dimension-marketplace
plugins op:install name:rail-t3 marketplace:dimension-marketplace
```

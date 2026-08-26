# Contributing a pack

Approval model: **a PR is the submission, the conformance suite is the bar,
review is the taste check.** No pack merges red.

## The pipeline

1. **Read the guide.** The end-to-end walkthrough (contracts, scaffolding,
   partition of concerns, conformance, registration) is maintained in the
   Dimension repository as `docs/guides/building-a-custom-space.md`. Start
   there; this file only adds the marketplace mechanics.
2. **Scaffold your pack** under `packs/<your-pack>/` mirroring
   `packs/independent-thread/`: `package.json` (name it under your own npm
   scope) with an `omp` block, `dimension.plugin.json`, `src/`, `vite.config.ts`
   declaring the four granted externals, and a committed `dist/`. That pack
   builds byte-identically from a bare directory with vite and nothing else —
   copy it if you want your pack to stay portable. If you instead need in-repo
   typechecking, add a `tsconfig.json` and be aware it couples your pack to the
   monorepo layout.
3. **Implement against the contract, not beside it.** Your component receives
   everything through props (data in) and speaks only ShellIntents (intents
   out). It holds no session state and talks to no engine. If you find
   yourself needing a capability the contract lacks, that is a FINDING: open
   an issue naming it.
4. **Pass the conformance suite** for your slot kind, in-pack
   (`bun test` inside your pack directory, run from the Dimension monorepo).
5. **Add your catalog entry** to `.omp-plugin/marketplace.json`: name, source
   (`./packs/<your-pack>`), description, version, author, license, category.
6. **Open the PR.** CI validates the catalog and pack layout; the monorepo CI
   runs your tests; a maintainer reviews for craft (design-token discipline,
   honest empty states, reduced-motion safety).

## House rules that will come up in review

- Design tokens only (`--fr-*` variables / `fr-` utility classes). No raw hex.
- Color is meaning: reserve it for act-now states.
- Honest states: empty, loading and failure are part of the component.
- `prefers-reduced-motion` is not optional.
- No second copy of anything the platform already renders.

## Licensing

Each pack declares its own `license` in its `package.json` and catalog entry.
The marketplace catalog itself is metadata.

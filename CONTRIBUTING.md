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
   scope) with a `dimension` block, `dimension.plugin.json`, `src/`, `vite.config.ts`
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
4. **Prove it.** For pure logic, tests in-pack (`packs/session-board/test/`
   is the shape; run from the Dimension monorepo if your pack takes workspace
   deps). For a slot fill claiming parity with a shipped surface, the gate is a
   live structural + behavioral comparison against that surface — the portable
   template ships no test directory precisely because its gate is that
   comparison, not a self-written assertion.
5. **Add your catalog entry** to `.dimension-plugin/marketplace.json`: name, source
   (`./packs/<your-pack>`), description, version, author, license, category.
6. **Open the PR.** CI validates the catalog and pack layout; the monorepo CI
   runs your tests; a maintainer reviews for craft (design-token discipline,
   honest empty states, reduced-motion safety).

## Your first space

1. **Install the SDK.**

   ```sh
   npm i -D @dimension/sdk
   ```

   Honest status: `@dimension/sdk` is **not on npm yet** — the publish lane is
   built, but the publish itself is pending the owner's `npm login`, so that
   command 404s today. Until it lands, an author working inside the Dimension
   monorepo takes the workspace dependency instead:
   `"@dimension/sdk": "workspace:*"`.
2. **Copy a template.** `packs/three-lane` is the LAYOUT template (it declares
   its own slots and ships the `demo-lane` space); `packs/mochi-mark` is the
   COMPONENT template (it fills one slot). A copy must edit, at minimum:
   - `package.json` — `name`, `description`, and the `omp` block (`name`,
     `description`, `category`, `keywords`).
   - `dimension.plugin.json` — see below.
   - `src/index.ts` — for a component its **default** export is what the host
     loads as the component; `mochi-mark/src/index.ts` says so in a comment.
   - component packs only: `vite.config.ts` and the committed `dist/`.
3. **Fill in `dimension.plugin.json`.** Both real manifests share `plugin`
   (the id the host resolves), `contractVersion` (`1`), `title` and `type`.
   Then they diverge:
   - `"type": "component"` (mochi-mark) adds `entry` (`"dist/index.mjs"`) and
     `slot` (`"mark"`) — the slot contract it fills.
   - `"type": "layout"` (three-lane) adds `slots`, each with an `id`
     (`"lane-left"`, `"lane-main"`, `"lane-dock"`, `"badge"`) and a `contract`
     (`"rail"`, `"workspace"`, `"dock"`, `"mark"`), plus an optional `items`.
   - A layout may also ship `spaces`, and an entry there IS the space:
     `specVersion`, `id`, `label`, `icon`, `order`, `description`, `mark`
     (`fill` / `accent` / `label`), `layout`, `components` (slot id → plugin
     id), `rail`, `workspace` (`surfaces`, `start`, `session`,
     `switchPolicy`), `generalAgents`, and `requires.plugins` — every plugin
     your space names in `components` or `mark.fill` belongs in that list.
4. **Validate before you push.**

   ```sh
   node scripts/validate-marketplace.mjs
   node scripts/sync-catalog.mjs --check
   ```

   The first checks the catalog and pack layout; the second fails if a pack
   manifest changed without the catalog being resynced (plain
   `node scripts/sync-catalog.mjs` rewrites it). Both must be green.
5. **Open the PR.** One pack per PR, against `main`. CI reruns both scripts;
   a maintainer reviews against the house rules below.

## House rules that will come up in review

- Design tokens only (`--fr-*` variables / `fr-` utility classes). No raw hex.
- Color is meaning: reserve it for act-now states.
- Honest states: empty, loading and failure are part of the component.
- `prefers-reduced-motion` is not optional.
- No second copy of anything the platform already renders.

## Licensing

Each pack declares its own `license` in its `package.json` and catalog entry.
The marketplace catalog itself is metadata.

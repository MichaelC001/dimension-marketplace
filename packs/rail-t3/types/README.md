# Vendored `@fraym/ui` contract declarations

`fraym-ui.d.ts` is GENERATED. Do not edit it.

Regenerate from the monorepo:

```bash
cd fraym/packages/ui && bun scripts/emit-contract-types.ts
cp contract-types/index.d.ts ../../../marketplace/packs/rail-t3/types/fraym-ui.d.ts
```

## Why this file exists

Before it, a pack implementing a slot contract could only reach the contract
types through the whole `@fraym/ui` barrel — which meant depending on this
monorepo. That made the marketplace's own reference pack un-authorable outside
the repo it ships in (doc 56 §3.3.1, finding #1).

The file is flattened and self-contained: it references `react` and nothing
else. `tsconfig.typecheck.json` maps `@fraym/ui` at it, so `bun run check:types`
proves the pack types against the real contracts with no `fraym/` on disk.

## What it does NOT do

It does not make the pack **installable** standalone. Mounting still needs the
runtime `@fraym/ui` — a `.d.ts` is not executable — so `@fraym/ui` remains a
**dev** dependency for the conformance test, and shipping this rail into an app
means that app bundles Fraym. The trusted-native-ESM tier stays fenced
(doc 44 §15); this is authorability, not a loader.

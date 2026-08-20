# Sessions (`session-board`)

Mission control in the dock: every session partitioned by **what it needs from
you** — blocked-on-input first, then working, then idle — with one-click
switching. Complements the rail (which owns navigation and recency) with an
urgency view: *"which of my ten agents is waiting on me right now?"*

This pack is the **worked example of the contributed-dock-component lane**
(lane opened 2026-08-19): a `dock`-slotted component that lands in the dock
strip beside the nine built-ins without a line of shell code changing. An
instrument is the ROLE you say out loud (doc 68 §1 ruling 3) — never a
manifest type.

## The declarations

1. **`dimension.plugin.json`** — `"type": "component"` with `"slot": "dock"`.
   `dock` is a well-known slot name (doc 68 §4.1); the shelf claim carries the
   slot plus the tab-strip fields the dock contract uses.

   ```json
   { "plugin": "session-board", "type": "component", "slot": "dock", "icon": "layers", "order": 100 }
   ```

   The engine validates this at load (`validateComponentDecl`, re-exported by
   `@dimension/sdk/component`) and settles the dock defaults ONCE: contributed
   dock components are `listed` by default (installing one is asking to see
   it) and `order` 100 — after the built-ins' 0–90 band.

2. **The module map entry** — same spine as components
   (`apps/web/src/main.tsx`): `componentModules: { "session-board": SessionBoard }`.
   The kit loader routes a `dock`-slotted component to the dock registry and
   registers it; ONE disposer unwinds it, so disable provably reverses install.

3. **Nothing else.** No space needs to bind it — the dock strip reads the
   dock registry, so the tab appears in every space whose dock is open.

## The import surface

```
react — everything.
```

The zero-import floor, demonstrated on the dock lane: props ARE the
`InstrumentContext` (the loader's wrap is one `createElement`), the host's
Store arrives on `ctx.store` (doc 68 §3.5 — the mount boundary hands it in),
and React's built-in `useSyncExternalStore` consumes the contract's
`{getSnapshot, subscribe}` shape directly. One watch (`sessions/list`) serves
the whole board — the catalog entries already carry `liveStatus` and
`blockedOnInput`. Selection is the Store's `act("selectSession", …)` — the
same verb the shipped rail uses.

## Styling

The author's own pixels, drawn on the host's published `--fr-*` custom
properties (`--fr-text-*`, `--fr-surface-2`, `--fr-border-soft`,
`--fr-warning`, `--fr-success`) — global CSS variables, so the board sits in
either theme with zero imports, per the marketplace house rules (design
tokens only; color-is-meaning stays the host's). The one animation (the
working dot's breathe) honors `prefers-reduced-motion`.

## Tests

- `test/partition.test.ts` — the pure urgency model: precedence
  (blocked > working > idle), archived exclusion, recency sort, phantom-row
  refusal, the `branch · worktree` composition.
- Monorepo side: `packages/space-sdk/test/session-board-manifest.test.ts`
  (the manifest passes engine validation) and
  `fraym/packages/ui/test/component-loader.test.tsx` (the loader lane:
  registration, defaults, ctx-as-props, disposal).

## Build

`bun run build` (vite lib mode) emits `dist/index.mjs` — the ESM bundle the
host loads at runtime, externalising exactly `react`, `react-dom`,
`react/jsx-runtime`, `@fraym/ui`. `dist/` is **committed**: a pack must be
installable with no build step.

The bundle's **default export is the component** (`SessionBoard`) — that is the
loader's whole contract; the named exports stay for in-tree and test importers.

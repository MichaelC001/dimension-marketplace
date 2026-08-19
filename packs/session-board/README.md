# Sessions (`session-board`)

Mission control in the dock: every session partitioned by **what it needs from
you** — blocked-on-input first, then working, then idle — with one-click
switching. Complements the rail (which owns navigation and recency) with an
urgency view: *"which of my ten agents is waiting on me right now?"*

This pack is the **worked example of the contributed-instrument lane** (lane
opened 2026-08-19): the fourteenth contribution type, and the first instrument
to land in the dock strip beside the nine built-ins without a line of shell
code changing.

## The declarations

1. **`dimension.plugin.json`** — `"type": "instrument"` is the whole shelf
   claim. No `slot`, no fit question: an instrument is a dock Surface
   (doc 44 §4.3), not a slot component.

   ```json
   { "plugin": "session-board", "type": "instrument", "icon": "layers", "order": 100 }
   ```

   The engine validates this at load (`validateInstrumentDecl`, re-exported by
   `@dimension/sdk/instrument`) and settles the defaults ONCE: contributed
   instruments are `listed` by default (installing one is asking to see it)
   and `order` 100 — after the built-ins' 0–90 band.

2. **The module map entry** — same spine as components
   (`apps/web/src/main.tsx`): `componentModules: { "session-board": SessionBoard }`.
   The kit loader zips the engine record with the module and registers it;
   ONE disposer unwinds it, so disable provably reverses install.

3. **Nothing else.** No space needs to bind it — the dock strip reads the
   instrument registry, so the tab appears in every space whose dock is open.

## The import surface

```
react — everything.
```

The zero-import floor, demonstrated on the instrument lane: props ARE the
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

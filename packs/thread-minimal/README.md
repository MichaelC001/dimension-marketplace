# Minimal Thread (`thread-minimal`)

A compact transcript for the session surface's **thread section**: role + text
rows from the Store's published session cells, with the working verb at the
tail. No wisp, no tool cards, no presence — minimal but REAL.

This pack is the **worked example of the contributed thread-SECTION lane**
(doc 69 §3.5): thread and composer are sections of the session surface —
declared by the surface, resolved like slots, never layout columns. A space
binds this pack through `workspace.sections.thread` and it replaces
`THREAD_CLASSIC` inside the session surface, with the shell's crash boundary
and classic fallback around it.

## The declarations

1. **`dimension.plugin.json`** — `"type": "component"` with `"slot": "thread"`.
   The loader routes every non-dock slot to the generic registry, so this pack
   lands with **zero loader edits**:

   ```json
   { "plugin": "thread-minimal", "type": "component", "slot": "thread", "entry": "dist/index.mjs" }
   ```

2. **The space binding** — a space names it in its manifest's workspace block
   (Demo Lane in `packs/three-lane` does exactly this):

   ```json
   "workspace": { "sections": { "thread": "thread-minimal" } }
   ```

   Absent binding ⇒ the shipped classic. An id resolving to nothing falls
   back to the classic with a bounded warning — never a blank thread.

## The import surface

```
react — everything.
```

The zero-import floor on the section lane: props are the section contract
(`ThreadSectionProps`, restated structurally), the host's Store arrives on
`props.store`, the session identity on `props.sessionRef`, and React's
built-in `useSyncExternalStore` consumes the contract's
`{getSnapshot, subscribe}` shape directly. Two watches serve the whole view:

- `session/<id>/transcript` — the merged transcript (structurally-stable
  snapshots; a re-render happens only on genuine transcript movement),
- `session/<id>/verb` — the working status shown at the tail.

Sends stay the host's: a composer (classic here) drives the session; a
richer pack would use the published verb set (`act("sendMessage", …)`).

## Styling

The author's own pixels, drawn on the host's published `--fr-*` custom
properties (`--fr-text-*`, `--fr-border-soft`, `--fr-accent`) — design tokens
only, per the marketplace house rules.

## Build

`bun run build` (vite lib mode) emits `dist/index.mjs` — the ESM bundle the
host loads at runtime, externalising exactly `react`, `react-dom`,
`react/jsx-runtime`, `@fraym/ui`. `dist/` is **committed**: a pack must be
installable with no build step.

The bundle's **default export is the component** (`MinimalThread`) — that is
the loader's whole contract; the named exports stay for in-tree and test
importers.

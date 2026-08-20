# Pulse Mark (`pulse-mark`)

A demo `mark` component: an activity beacon that ignites while any session is
working, fed by the host Store through the one granted binding. Import
surface: `react` only.

## Build

`bun run build` (vite lib mode) emits `dist/index.mjs` — the ESM bundle the
host loads at runtime, externalising exactly `react`, `react-dom`,
`react/jsx-runtime`, `@fraym/ui`. `dist/` is **committed**: a pack must be
installable with no build step.

The bundle's **default export is the component** (`PulseMark`) — that is the
loader's whole contract; the named exports stay for in-tree and test importers.

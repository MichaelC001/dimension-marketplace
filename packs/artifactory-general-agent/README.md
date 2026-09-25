# The Forge — General Agents

The General Agents tab and the way you make one. No forms: an agent is an
**orrery**, and you build it by putting things in orbit.

Status: **slice 1 of the Forge epic — the View**, running standalone with
preview data. It is not an installable plugin yet: no `plugin.json`, no MCP
server, nothing written to disk. See "What lands next".

```sh
bun install
bun run dev      # http://localhost:5197 — preview mode, seeded agents
bun run build    # app/dist — the bundle the pack's MCP server will serve as ui://
```

## The design

**Constellation (the tab).** Every General Agent is a body in one field. Its
shape is its vibr; the faint orbits around it are how many capability families
it carries; arcs between bodies are lineage (`extends`), with a light
travelling from parent to child. The hollow cage in the middle is the seed —
click it to forge a new agent. A plain index on the right lists the same
agents for keyboard and screen-reader use.

**Forge (one agent).** The mind is the core; every capability family is one
orbit, in the aurora hue Fraym already sanctions:

| Orbit | Hue | Manifest key | Empty orbit means |
|---|---|---|---|
| Tools | accent | `capabilities.tools` | every tool (key omitted) |
| Skills | blue | `capabilities.skills` | every skill |
| MCP | iris | `capabilities.mcp` | every server |
| Memory | cyan band | `memory.backend` (+ `vault: global`) | inherits the host's |
| Lineage | silver, with a beam to the core | `extends` | none |

Gestures, all of which rewrite the `agent.md` beside the orrery live (changed
lines flash):

- **Drag a part** from the tray onto the stage: its orbit lights while you
  drag, and the body flies from where you dropped it into its slot. Clicking a
  part does the same.
- **Fling a body off its orbit** to release it (or select it and press Delete).
- **Drag the core up or down** to change how hard it thinks
  (`engine.thinkingLevel`); the core brightens and churns faster.
- **Double-click the core** to open the vibr wheel: twelve bodies around it,
  hover to try one on, click to keep it.
- **The cage** around the core is the approval gate (`gate.approval`): dense
  asks before everything, sparse asks before writes, none runs free.
- **The pedestal** below is where it lives (`workspace.policy`): tethered to
  the workspace it was opened in, its own home, or a dashed scratch ring.
- **The line at the bottom** talks to the workshop session — describe the
  agent and it is built here while you watch (inside Dimension; the preview
  says so honestly).

Name, one-line purpose and charter are typed, because they are words; they are
typography on the stage, not fields in a form.

## Honesty rules the View keeps

- It only emits keys `omp/packages/coding-agent/src/config/agent-manifest.ts`
  accepts. That parser rejects unknown keys (`identity.vibr` → "vibr must be
  removed"), so the vibr is written as a YAML comment until the schema slice
  lands. Every preview agent's output was round-tripped through the real
  `parseAgentManifest` with zero failures.
- Preview forging keeps agents in `localStorage` and says nothing was written.
- The preview catalog names real tools, skills, MCP servers and agents; the
  agents' loadouts are illustrative, labelled so in `catalog.ts`.

## What lands next (board epic "General Agents — the Forge")

1. Pack MCP server: `agent_open` (model-facing, carries the `ui://` View) and
   app-only `list_agents` / `list_parts` / `get_agent` / `save_agent`; the
   View swaps its preview store for the ext-apps bridge.
2. Engine `POST /agent/create` — the trigger-less sibling of `/loop/create`.
   `capabilities.tools` and `gate.approval` are human-confirmed writes.
3. `identity.vibr` in the manifest schema.
4. The General Agents rail door + surface seating this View, with a
   Machinist-style workshop session in the dock.
5. Live proof on the dev desktop, twice green.

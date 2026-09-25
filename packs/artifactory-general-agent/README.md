# The Forge — General Agents

The General Agents tab and the way you make one. No forms: an agent is an
**orrery**, and you build it by putting things in orbit.

Status: **slice 2 of the Forge epic — the App.** An installable artifactory
pack: an MCP server the engine hosts (doc 45 §8), a View it seats in the
artifact view, and real `agent.md` files read and written in the workspace.
The standalone preview still runs for design work. Not yet proven on the live
dev desktop — see "What lands next".

```sh
bun install          # from the Dimension monorepo: @dimension/sdk is a workspace dependency
bun run dev          # http://localhost:5197 — preview mode, seeded agents, nothing written
bun run build        # app/server.mjs (esbuild) + app/dist (vite); both are committed
bun run check:types  # two programs: the View, and the server under the engine's rules
bun run test         # the server's contracts
```

## The App

| Tool | Who calls it | What it does |
|---|---|---|
| `forge_open { agent?, workspace? }` | the model | Mounts the View on the constellation, or on one agent. `workspace` binds the session's workspace (below). |
| `forge_propose { name, description?, charter?, vibr?, skills?, mcp?, memory?, lineage?, thinking?, personality?, habitat? }` | the model | Talk-to-build: pushes a draft into the View, marked **proposed by the workshop** until the human accepts or discards it. Writes nothing. Has no `tools` or `approval` field. |
| `list_agents` | the View | `.inso/agents/*/agent.md` (+ legacy `.omp/agents`, read-only) and every installed pack's `general-agents/*/agent.md` (read-only), each parsed by `@dimension/sdk/general-agent`'s `parseGeneralAgent`. |
| `list_parts` | the View | Skills and MCP servers read from the workspace, `$INSO_HOME/agent` and every installed pack; tool names only as existing agents already use them — the host exposes no tool registry to Apps, and the tray says so. |
| `save_agent { draft, create }` | the View | Serializes with the SAME `src/agent-md.ts` the View renders, re-parses with `parseGeneralAgent`, refuses a taken or invalid name, never rewrites a Loop or a file whose settings the Forge cannot show, then writes `.inso/agents/<name>/agent.md` atomically (temp + rename) and returns the path. |

**Where the workspace comes from.** The engine spawns this server once, from
the plugin's own root, with only its home in the environment (`INSO_HOME`,
`INSO_VAULT_DIR`, `INSO_ENV`); a call's session `_meta` names the session but
not its workspace. So the agent names it: `forge_open { workspace }` binds that
session's workspace, and the View's calls — stamped with the same session —
resolve against it. `DIMENSION_FORGE_WORKSPACE` is the fallback for a session
that never named one. Without either, the View says so instead of guessing.

**Security (doc 58 §3).** `capabilities.tools` and `gate.approval` change only
by a human gesture in the View: `forge_propose` cannot carry them (its schema
has neither), merging a proposal never touches them, and `save_agent` is
App-only — the model cannot write a file at all.

`modelSpaces` grants the model surface in every space that exists today:
`code` (compiled in), `build`, `example-hub`, `phone` (community packs) and
`traction`.

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
- **The line at the bottom** talks to your agent: the words go to the session
  as yours (`ui/message`), and what the agent proposes lands here for you to
  accept. In the preview there is no agent to talk to, and it says so.

Name, one-line purpose and charter are typed, because they are words; they are
typography on the stage, not fields in a form.

## Honesty rules the View keeps

- It only emits keys `omp/packages/coding-agent/src/config/agent-manifest.ts`
  accepts, plus the Dimension keys `parseGeneralAgent` reads beside them; the
  vibr is dimension#1042's top-level `avatar:`. It never emits `autonomy:` — a
  trigger makes a Loop, not an agent.
- An agent whose file carries settings the orrery cannot show (a `loop:`
  budget, `capabilities.ignore`, an inherited approval, …) opens read-only with
  the reason, instead of being silently rewritten without them. Pack agents
  are read-only; "Extend it" forges a new agent with `extends: [<it>]`.
- The preview keeps agents in `localStorage` and says nothing is written; its
  catalog (`catalog.ts`) is used only when there is no host.

## What lands next (board epic "General Agents — the Forge")

1. Live proof on the dev desktop, twice green.
2. Engine `POST /agent/create` — the trigger-less sibling of `/loop/create` —
   and an engine-supplied workspace on App calls (`workspaceId` in the session
   `_meta` is reserved today), which retires `forge_open`'s `workspace` argument.
3. A tool registry the host lends Apps, so the Tools tray is complete.
4. The General Agents rail door + surface seating this View, with a
   Machinist-style workshop session in the dock.

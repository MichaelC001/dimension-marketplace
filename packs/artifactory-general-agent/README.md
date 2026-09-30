# The Forge — General Agents

The General Agents tab and the way you make and configure one. No forms: an
agent is an **orrery**, and you build it by putting things in orbit — then
everything the orrery does not draw is one tab away.

Status: an installable artifactory pack: an MCP server the engine hosts
(doc 45 §8), a View it seats in the artifact view, and real `agent.md` files
read and written in the user's own agents (and, when a project is bound, the
project's). The standalone preview still runs for design work. It covers every
part of a General Agent doc 83 (`docs/design/83-traction-onboarding.md`) and
epic #1348 ship: the home (#1353), listed vs enabled (#1354), a charter that
speaks as itself (#1355), memory reach (#1356) and memory that follows the agent
(#1357).

```sh
bun install          # from the Dimension monorepo: @dimension/sdk and @dimension/mcp-app-kit are workspace dependencies
bun run dev          # http://localhost:5197 — preview mode, seeded agents, nothing written
bun run build        # app/server.mjs (esbuild) + app/dist (vite); both are committed
bun run check:types  # two programs: the View, and the server under the engine's rules
bun run test         # the server's contracts
```

## The door

The pack contributes a **General Agents** entry to the rail
(`railActions`, `session.agent: machinist`, seating `forge_open`): one click
opens a session as the Machinist with the Forge in the artifact view. The rail
draws it only while the pack is enabled — it ships `defaultEnabled: false`, so
turn it on in Capabilities → Plugins. The model can also open it itself with
`forge_open`.

The door passes no workspace, and the Forge does not need one: it lists the
packs' agents and the user's own, and creates new agents into the user tier. A
workspace only adds that project's agents (`forge_open { workspace }`).

## Tiers — where an agent lives

| Tier | Path | Home | Forge |
|---|---|---|---|
| **pack** | `<pack>/general-agents/<name>/agent.md` | yes (`home-<name>`) | read-only; "Extend it" forges a new agent with `extends: [<it>]` |
| **user** ("Your agent") | `$INSO_HOME/agent/agents/<name>/agent.md` — where `agent_create` writes | yes | read, edit, **create here** |
| **project** | `<workspace>/<PI_CONFIG_DIR>/agents/<name>/agent.md` (legacy `.omp/agents` is read-only) | none: it belongs to one project | read and edit when a workspace is bound |

Precedence is the engine's: packs own their names, then the project, then the
user; a shadowed file is reported. Every agent says which tier it lives in, in
the roster and under its name.

## The App

| Tool | Who calls it | What it does |
|---|---|---|
| `forge_open { agent?, workspace? }` | the model, and the rail door | Mounts the View on the constellation, or on one agent. `workspace` is optional: it adds the project's agents. |
| `forge_propose { name, description?, charter?, vibr?, skills?, mcp?, memory?, lineage?, thinking?, personality?, habitat?, extra? }` | the model | Talk-to-build: pushes a draft into the View, marked **proposed by the workshop** until the human accepts or discards it. Writes nothing. Has no `tools` or `approval` field, and refuses an `extra` that names a grant-class key (below). |
| `list_agents` | the View | All three tiers, each parsed by `@dimension/sdk/general-agent`'s `parseGeneralAgent`, with its tier, path, revision and whether it is editable. |
| `list_parts` | the View | Skills and MCP servers read from the workspace, `$INSO_HOME/agent` and every installed pack; tool names only as existing agents already use them — the host exposes no tool registry to Apps, and the tray says so. |
| `validate_agent { draft }` | the View | The server's verdict on a draft — its own problems, then whether the merged `agent.md` loads as a General Agent — without writing. Drives the live error under Everything else. |
| `save_agent { draft, create, tier?, revision? }` | the View | Serializes with the SAME `src/agent-md.ts` the View renders, re-parses the WHOLE file with `parseGeneralAgent` before anything touches disk (a parse error is refused, never written), then writes atomically (temp + rename). `create: true` writes a new agent into the user tier and refuses a name taken in any tier. `create: false` rewrites the agent of that `tier` and is refused unless `revision` is the one `list_agents` gave — a hand edit since is never overwritten unseen. Never rewrites a Loop. |
| `agent_home { name }` | the View | The agent's home: id, folder, whether the engine registers it, the memory room, and its standing instructions (below). Works for a name that does not exist yet. |
| `save_instructions { name, text }` | the View | Writes the agent's standing instructions (below). The path is derived from the name, never given. |

**Where things are read from.** The engine spawns this server once, from the
plugin's own root, with its home and project config dir in the environment
(`INSO_HOME`, `INSO_VAULT_DIR`, `INSO_ENV`, `PI_CONFIG_DIR`); a call's session
`_meta` names the session but not its workspace. The home is enough for the
pack and user tiers. A project's agents need a workspace: the model names it with
`forge_open { workspace }`, which binds that session's workspace, and the View's
calls — stamped with the same session — resolve against it.
`DIMENSION_FORGE_WORKSPACE` is the fallback. Without either, the View says no
workspace is bound and everything but project agents still works.

**Security (doc 58 §3).** The keys that grant — `capabilities.tools`,
`gate.approval`, `workspace.*` (the Recall switch is `workspace.reach`),
`capabilities.control`, `capabilities.plugins`, `capabilities.mcp`,
`capabilities.optIn`, `subagents.allowed`, `harness`, `allowedHarnesses` — change
only by a human gesture in the View. `forge_propose` cannot carry them: its
schema has none of the drawn ones; an `extra` that names any grant-class key
(even inline, or through the legacy flat `tools:` / `spawns:`) is refused whole;
and merging a proposal into a draft never applies one, whatever reaches the View.
`save_agent` and `save_instructions` are App-only — the model cannot write a file
at all.

`modelSpaces` grants the model surface in every space that exists today:
`code` (compiled in), `build`, `example-hub`, `phone` (community packs) and
`traction`.

## The design

**Constellation (the tab).** Every General Agent is a body in one field. Its
shape is its vibr; the faint orbits around it are how many capability families
it carries; arcs between bodies are lineage (`extends`), with a light
travelling from parent to child. The hollow cage in the middle is the seed —
click it to forge a new agent. A plain index on the right lists the same
agents for keyboard and screen-reader use, with each one's tier. When the host
lends it (below), an agent that is **off** is struck through and one **hidden
from the rail** is italic, with a small badge.

**Forge (one agent).** The mind is the core; every capability family is one
orbit, in the aurora hue Fraym already sanctions:

| Orbit | Hue | Manifest key | Empty orbit means |
|---|---|---|---|
| Tools | accent | `capabilities.tools` | every tool (key omitted) |
| Skills | blue | `capabilities.skills` | every skill |
| MCP | iris | `capabilities.mcp` | every server |
| Memory | cyan band | `memory.backend` | inherits the host's |
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
  asks before everything, sparse asks before writes, none runs free. A fourth
  position, **Host's**, writes no approval at all, so the host's own mode applies
  — the state of a file that never said, never changed by a save.
- **The pedestal** below is where it lives (`workspace.policy`): tethered to
  the workspace it was opened in, its own home, or a dashed scratch ring.
  **Own home** writes `workspace: { policy: home, id: home-<name> }` — the id
  the engine registers (the SDK's `agentHomeWorkspaceId`, supplied by the
  server, never spelled in the View). An older Forge wrote `agent-<name>`, which
  no registry knows: it still reads as the same switch, and a reforge repairs it.
  A project agent has no home, so the segment is disabled for it.
- **The Recall switch** sets how far its memory reads: this project (nothing
  written), or every project (`workspace.reach: all`). Reach is the agent's one
  cross-project grant, so it also lets the agent's control tools target every
  workspace.
- **Enabled** and **In rail** are the host's own switches: what the
  Capabilities page flips, through the `agents:configure` grant (below).
- **The line at the bottom** talks to your agent: the words go to the session
  as yours (`ui/message`), and what the agent proposes lands here for you to
  accept. In the preview there is no agent to talk to, and it says so.

Name, one-line purpose and charter are typed, because they are words; they are
typography on the stage, not fields in a form. A new agent's charter **speaks
only as itself** (`identity.prompt: replace`, the manifest default): the charter
is its whole prompt. "Builds on the default agent" (`append`) puts it after the
full coding prompt, and is a choice — the right one only for an agent that
extends `coding` (dimension#1355).

### The aside — four tabs

- **Charter** — the prompt mode and the charter text.
- **agent.md** — the exact file that will be written, merged lines included.
- **Everything else** — every manifest key the orrery does not draw, as YAML
  text: `title`, `defaultEnabled`, `defaultListed`, `engine.model` / `profile` /
  `roles`, `capabilities.control` / `plugins` / `autoloadSkills` /
  `slashCommands` / `optIn` / `ignore`, `memory.namespace`, `subagents`, `loop`,
  `routing`, `harness`, `allowedHarnesses`, `gate.policy` — and any drawn key
  whose value the orrery cannot draw (an avatar with a skin or accent, a
  contributed avatar, `thinkingLevel: auto`, a reach that lists workspaces, a
  pinned workspace, an allowlist of `"*"` or `[]` — *none*, which would otherwise
  flip to *all*). It is kept verbatim — comments included — and merged back into
  the file section by section (keys written at another indent join the orrery's
  own). The whole merged file is re-validated with `parseGeneralAgent` live (a
  parse error is shown under the text) and again at save (a parse error is
  refused, nothing written). When Everything else holds a key the orrery also
  draws, that orrery control stands aside and says *In Everything else* rather
  than change nothing. The nameplate, lineage and prompt mode cannot be taken over
  from here. Grant-class keys set here are flagged as yours alone.
- **Home** — the agent's home, where its instructions come from, and where its
  memory reads. See below.

An agent is read-only only when it truly cannot be written: a pack agent, a
legacy `.omp/agents` file, or a Loop (which is not listed at all).

### Home

- **Id, folder, standing.** `home-<name>`, or *no home* with the reason (a
  project agent belongs to one project; an agent naming another `workspace.id`
  stands there instead). The folder is `$INSO_HOME/workspaces/<home id>`, which
  the engine pins as `PI_AGENT_HOMES_DIR`; it is made the first time the agent
  is opened. The tab says whether the agent **stands** there (Lives → Own home)
  or only **reads** it — its instructions and memory follow it either way.
- **Standing instructions.** The agent-level `AGENTS.md`, resolved exactly as
  OMP does (`omp/packages/coding-agent/src/config/general-agents.ts`): one file
  loads per session, the first hit of (1) a project's own copy
  `<project>/agents/<name>/AGENTS.md` — pack agents only, any file claims it;
  (2) the home `AGENTS.md` — pack and user agents, only when it is **not
  empty**, so an empty file never hides the next; (3) the `AGENTS.md` beside
  `agent.md`. Every candidate is listed with its state and the winner marked.
  For a user or project agent the text is editable: a save writes the home
  `AGENTS.md` once the home folder exists, else the sibling (which seeds the home
  on its first provisioning). A pack agent's resolution is shown, read-only.
- **Memory reads from.** This agent's room, its home room (memory follows the
  agent from project to project), and the global lane — or every room when the
  reach is `all` (`packages/engine/src/providers/memory-reach.ts`). The tab notes
  that `memory.namespace` does not isolate Engram: only the mnemopi runtime
  applies it.

## Visibility — the `agents:configure` grant

The artifactory declares `grants: ["agents:configure"]`. A host that honours it
lends the View the host's own record of every General Agent (enabled, shown in
the rail, defaults, home, provenance) in host context, and answers
`ai.insodimension/agents/configure` — written through the same writers the
Capabilities page's enable switch and Show-in-rail toggle use (no new engine
route). The Forge reads it through `@dimension/mcp-app-kit/agents`. It draws the
**Enabled** and **In rail** instruments for an agent, and marks the constellation.
Where the host does not lend the key (the preview, an older host) the View says
so in a single *Rail · Not offered* instrument instead of drawing switches that
would do nothing.

## Honesty rules the View keeps

- The orrery only emits keys `omp/packages/coding-agent/src/config/agent-manifest.ts`
  accepts, plus the Dimension keys `parseGeneralAgent` reads beside them; the
  vibr is dimension#1042's top-level `avatar:`. It never emits `autonomy:` — a
  trigger makes a Loop, not an agent (and Everything else cannot smuggle one in:
  the merged file would load as a Loop, and is refused).
- Nothing in a file is unshown and dropped. The retired `memory.vault` is the one
  key a rewrite removes (the parser already ignores it).
- The preview keeps agents in `localStorage` and says nothing is written; its
  catalog (`catalog.ts`) is used only when there is no host.

## What lands next

1. Live proof on the dev desktop, twice green.
2. Engine `POST /agent/create` — the trigger-less sibling of `/loop/create` —
   and an engine-supplied workspace on App calls (`workspaceId` in the session
   `_meta` is reserved today), which retires `forge_open`'s `workspace` argument.
3. A tool registry the host lends Apps, so the Tools tray is complete.
4. The inspector report (`AgentReport`, doc 84) as a Forge panel — it needs a
   live session, not an agent file.

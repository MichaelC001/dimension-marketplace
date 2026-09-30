# General Agents

Every General Agent you can run, as cards on one page — and, one click in,
each agent's whole profile: its tools, skills, plugins and MCP servers, its
charter and standing instructions, its home and memory, whether it is on and
in the rail, and every other key of its manifest. The profile is also where
you edit an agent and where you create a new one, by hand or with the
Machinist, who sits in the dock beside the page.

Status: an installable artifactory pack — an MCP server the engine hosts
(doc 45 §8) and a View it seats as a whole page in the Code rail. It reads and
writes real `agent.md` files in the user's own agents (and, when a project is
bound, the project's). A standalone preview runs for design work.

```sh
bun install          # from the Dimension monorepo: @dimension/sdk, @dimension/mcp-app-kit, @fraym/ui and @fraym/config are workspace dependencies
bun run dev          # http://localhost:5197 (FORGE_PREVIEW_PORT to move it) — preview mode, seeded agents, nothing written
bun run build        # app/server.mjs (esbuild) + app/dist (vite, the App kit's config); both are committed
bun run check:types  # two programs: the View under the kit's compiler settings, and the server under the engine's
bun run test         # the server's contracts and the page's rules
```

## The door

The pack contributes a **General Agents** entry to the Code rail
(`railActions`: `target: page`, `surface: page`, `session.agent: machinist`,
seating `forge_open`). One click opens the page full-width, exactly like
Autonomy: Code's generic `page` surface binds the host's `page-view` fill, so
the page needs no app code. The page's backing session is the Machinist's, and
the Machinist lives in the dock beside the page — the page's own dock button
(top right) opens it. The rail draws the entry only while the pack is enabled —
it ships `defaultEnabled: false`, so turn it on in Capabilities → Plugins. In a
space that does not host the `page` surface the entry opens as a session with
the View in the artifact column instead.

Grants (`artifactories[].grants`): `agents:configure` (the host's record of who
is on and in the rail, and the two switches), `dock:open` (the Machinist's dock
button), `session:open` and `view:split`.

The door passes no workspace, and the page does not need one: it lists the
packs' agents and the user's own, and creates new agents into the user tier. A
workspace only adds that project's agents (`forge_open { workspace }`).

## The page

**Home.** A hero band with the page's name and the roster's count — agents, on,
in the rail, yours — and the one button, **New agent**. Facet pills narrow the
cards: All, Yours, From packs, This project, Off (the last only where the host
lends the switches). Each card is the house's hero card (`MarkCard`, the
Harnesses and Memory providers card) with the agent's live vibr in its well,
its name (its `title`, else its name), two lines of what it is for, its tier and
where it stands: *On · In rail*, *On · Hidden from rail* or *Off*. Faces hold
still until the pointer or the keyboard reaches their card (the orb, the page's
own face, always moves: it paints through one shared GL pool). Arrow keys, Home
and End move between cards. A card carries no action; it opens the profile.

**Profile.** The header holds the agent's face at hero size, its name and
title, what it is for, its tier, lineage and file path, where it stands — and
the page's one action: **Save changes**, **Create agent**, or, for a pack's
agent, **Extend as a new agent** (a new agent of yours with `extends: [<it>]`).
Beside it, the host's **Enabled** and **Show in rail** switches. Below, titled
cards, each a list of facts edited in place:

| Card | What it holds |
|---|---|
| Identity | name (typed once, when creating), description, face (the kit's vibr picker over the host's own roster — a vibr added to the kit is wearable here with no pack edit), personality, and how it speaks: *Speaks only as itself* (`identity.prompt: replace`, the default) or *Builds on the default agent* (`append`, right only for an agent that extends `coding`, dimension#1355) |
| Charter | the `agent.md` body |
| Standing instructions | the agent-level `AGENTS.md`, resolved exactly as OMP resolves it (a project's copy for a pack agent, then the home file when it holds text, then the file beside `agent.md`), every candidate with its state and the winner marked, and an editor for the file a save writes — refused if that file changed, or the home appeared, since it was read |
| Home | its id (`home-<name>`), folder, whether it stands there or only reads it, and why it has none when it has none |
| Memory | backend, recall reach (*This project* / *Every project* = `workspace.reach: all`), the rooms it reads, and a note that `memory.namespace` isolates only under Mnemopi |
| Capabilities | tools, skills and MCP servers as chip pickers (empty = every one), and plugins |
| Brain | its model stack (`engine.model`) and thinking level |
| Safety & access | approval gate, where it runs (where opened / its own home / a scratch worktree), control lanes |
| Lineage | the agents it extends |
| Advanced | *Everything else* — every other manifest key as YAML, validated as you type — beside the exact `agent.md` that will be written |

Keys that grant (tools, MCP servers, plugins, approval, where it runs, recall
reach, control lanes) are marked **Only you can change this**.

A read-only agent (a pack's, or a legacy `.omp/agents` file) opens the same
profile with every control disabled, the reason stated, and the Extend action.

**Create.** *New agent* opens the same profile as a draft: a new agent wears the
orb, speaks only as itself and asks before every action. Name, description and
charter are checked inline; *Create agent* writes it into the user tier.

**The Machinist's proposals.** `forge_propose` lays a draft on the profile it
names, under a *Proposed by the Machinist* banner that lists what it changed;
the changed facts are marked. Accept keeps them (nothing is written until you
save), Discard puts the profile back as it was.

## Tiers — where an agent lives

| Tier | Path | Home | On this page |
|---|---|---|---|
| **pack** | `<pack>/general-agents/<name>/agent.md` | yes (`home-<name>`) | read-only; *Extend as a new agent* |
| **user** ("Yours") | `$INSO_HOME/agent/agents/<name>/agent.md` — where `agent_create` writes | yes | read, edit, **create here** |
| **project** | `<workspace>/<PI_CONFIG_DIR>/agents/<name>/agent.md` (legacy `.omp/agents` is read-only) | none: it belongs to one project | read and edit when a workspace is bound |

Precedence is the engine's: packs own their names, then the project, then the
user; a shadowed file is reported.

## The App

| Tool | Who calls it | What it does |
|---|---|---|
| `forge_open { agent?, workspace? }` | the model, and the rail door | Opens the home, or one agent's profile. `workspace` is optional: it adds the project's agents. |
| `forge_propose { name, description?, charter?, vibr?, skills?, memory?, lineage?, thinking?, personality?, habitat?, extra? }` | the model | Talk-to-build: lays a draft on the profile, marked **Proposed by the Machinist** until the human accepts or discards it. Writes nothing. Has no `tools`, `mcp` or `approval` field, and refuses an `extra` that names a grant-class key (below). |
| `list_agents` | the View | All three tiers, each parsed by `@dimension/sdk/general-agent`'s `parseGeneralAgent`, with its tier, path, revision and whether it is editable. |
| `list_parts` | the View | Skills and MCP servers read from the workspace, `$INSO_HOME/agent` and every installed pack; tool names only as existing agents already use them — the host exposes no tool registry to Apps. |
| `validate_agent { draft }` | the View | The server's verdict on a draft — its own problems, then whether the merged `agent.md` loads as a General Agent — without writing. |
| `save_agent { draft, create, tier?, revision? }` | the View | Serializes with the SAME `src/agent-md.ts` the View renders, re-parses the whole file with `parseGeneralAgent` before anything touches disk, then writes atomically. `create: true` writes a new agent into the user tier and refuses a name taken in any tier; `create: false` rewrites the agent of that `tier` and is refused unless `revision` is the one `list_agents` gave. Never rewrites a Loop. |
| `agent_home { name }` | the View | The agent's home: id, folder, whether the engine registers it, the memory room, and its standing instructions with the `revision` of the file a save would write. |
| `save_instructions { name, text, revision }` | the View | Writes the agent's standing instructions; the path is derived from the name, never given; refused unless `revision` still matches. |

**Where things are read from.** The engine spawns this server once, from the
plugin's own root, with its home and project config dir in the environment
(`INSO_HOME`, `INSO_VAULT_DIR`, `INSO_ENV`, `PI_CONFIG_DIR`). A call's session
`_meta` names the session but not its workspace, so the model names it with
`forge_open { workspace }`; `DIMENSION_FORGE_WORKSPACE` is the fallback.

**Security (doc 58 §3).** The keys that grant — `capabilities.tools`,
`gate.approval`, `workspace.*`, `capabilities.control`, `capabilities.plugins`,
`capabilities.mcp`, `capabilities.optIn`, `subagents.allowed`, `harness`,
`allowedHarnesses` — change only by a human gesture on the profile.
`forge_propose` cannot carry them: its schema has none of the drawn ones; an
`extra` that names any grant-class key is refused whole — read as text and again
as the YAML it parses to; and merging a proposal into a draft never applies one,
whatever reaches the View. `save_agent` and `save_instructions` are App-only —
the model cannot write a file at all.

## Honesty rules the View keeps

- The profile only emits keys `agent-manifest.ts` accepts, plus the Dimension
  keys `parseGeneralAgent` reads beside them; the face is dimension#1042's
  top-level `avatar:`, written only when set. It never emits `autonomy:`.
- Nothing in a file is unshown and dropped: a key the profile does not draw — or
  a drawn key it cannot draw faithfully (an avatar with a skin, `thinkingLevel:
  auto`, a reach that lists workspaces, a pinned workspace, an empty allowlist) —
  rides in *Everything else* verbatim, and its control says *set in Everything
  else*. The retired `memory.vault` is the one key a rewrite removes.
- A face this page cannot paint (a contributed `plugin:` face) shows the host's
  neutral agent face, exactly as the rail does.
- The preview (`app/view/preview.ts`) is used only when there is no host, keeps
  everything in memory and says nothing is written. `?state=` picks the screen:
  `home`, `empty`, `loading`, `error`, `profile`, `readonly`, `create`,
  `proposal`, `rich`; `&dock=off` and `&rail=off` drop the dock station and the
  switches.

## What lands next

1. Live proof on the dev desktop, twice green.
2. An engine-supplied workspace on App calls (`workspaceId` in the session
   `_meta` is reserved today), which retires `forge_open`'s `workspace` argument.
3. A tool registry the host lends Apps, so the Tools picker is complete.
4. The inspector report (`AgentReport`, doc 84) on the profile — it needs a
   live session, not an agent file.

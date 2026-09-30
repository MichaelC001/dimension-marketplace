# Viewer

A tabbed document viewer beside the conversation (an artifactory, doc 45): images,
PDF, HTML, Markdown, Word, PowerPoint, Excel and plain text, rendered offline in a
sandboxed frame. The View is `app/view` (built to `app/dist`); the MCP server is
`src/` (bundled to `app/server.mjs`). Both built files are committed.

## Tools

| Tool | Who calls it | Does |
|---|---|---|
| `view_file { path, filename?, annotate? }` | the model, or the host on a click | Resolves `path` through the fence and mounts the View on it. `annotate: true` opens the file in the View's annotate mode (marks on a picture, comments on text) and is ignored for a kind with nothing to annotate. |
| `read_file_chunk { path, offset, length }` | the View only (`visibility: ["app"]`) | Streams a file's bytes to the View, at most 4 MiB a call. |

## What `opens` declares

`plugin.json` declares, beside `mcpServer`, what this viewer can open from outside
itself (`ArtifactoryDecl.opens`, doc 86 §3.2): one entry per family it really draws,
each `{ tool: "view_file", pathArg: "path", ext, mime, annotates, label }`. The engine
publishes them as the root Store fact `artifactory/opens`; a card in the thread reads it
to show an Open button and to name the handler, so nothing outside this pack hard-codes
"the viewer".

| Family | Extensions | `annotates` |
|---|---|---|
| Images | png, jpg, jpeg, gif, webp, avif, bmp, ico, svg | `marks` |
| PDF, Word, PowerPoint, Excel | pdf, docx, pptx, xlsx, xlsm | `text` |
| Markdown | md, markdown, mdx | `text` |
| Text and code | txt, log, csv, tsv, json, yaml, toml, xml, css, js, ts, py, rs, go, java, c, cpp, sh, sql and the like | `text` |
| HTML | html, htm, xhtml | none: the page is drawn in a `sandbox=""` frame nothing outside can select in |

`annotates` is a promise the View keeps: `marks` and `text` are the two models the
View's annotate layer implements today (`@dimension/mcp-app-kit/annotate`, doc 85).
Binaries and archives are not declared: the View shows them as a file card, which is
not "opening" them. `test/manifest.test.ts` holds the declaration to the SDK validator
and to the host's own `classifyFile` / `pickHandler`.

## A click-open is a host-lent, one-file grant

The fence (`src/fence.ts`) answers "which files may a model-callable tool read", and
for a model that is: the vault, `VIEWER_ROOTS`, never a secret. A human clicking Open
on a card for a file the agent made in a project folder is a different fact, and only
the host can attest to it. The pack declares `grants: ["files:read"]`, and then:

* the engine stamps `_meta["ai.insodimension/grant"] = { read: [<realpath>] }` on the
  host call that opens the file and on every later call that View instance makes
  (the `read_file_chunk` calls included), and strips the key from every call it did not
  stamp, so a View or a model cannot forge one;
* the fence reads it as **exactly those files**: the requested path, resolved to its real
  path, must equal a lent real path. Never a folder and everything under it, never a
  sibling, never a parent, and only a regular file;
* the deny rules (`.env`, private keys, credential stores, the Locker, the engine's agent
  state, UNC and device paths) run first and still refuse a lent path: a click cannot
  open a secret;
* the fence does not trust the engine's stripping. Any flaw in the grant (not an
  object, `read` not a list, a non-string, relative or tricked entry, more than 8 files)
  is no grant at all, and no grant leaves the roots exactly as they were.

A server that does not declare `files:read` is never stamped, so the viewer stays
deny-by-default for everything a human did not click.

## Accepted risks

The fence decides from names and real paths. Two things it does not look at, both
needing a process that can already write to the disk:

* **Hard links.** A hard link to a secret is the secret's bytes under a harmless name:
  its `realpath` is the harmless name, the deny rules do not match it, and the viewer
  does not read link counts. So a hard link inside a root (or one a human clicks) opens.
  Whoever can create one (`ln`, `mklink /H`) can already read the secret, and the bytes
  go to the user's View, never to the model (`read_file_chunk` is app-only; the model
  learns the kind and size).
* **A link swapped in after the check.** `realpath` and the open are two calls. A writer in
  the same directory can swap a link in between them, and the open follows it. The open
  handle is re-checked to be a regular file (a FIFO or directory swapped in is refused);
  its identity is not pinned. This is the same power as a shell.

## Build and test

```sh
bun run build      # app/server.mjs and app/dist (validates plugin.json with the SDK first)
bun test test/     # from this directory
```

The host runs `app/server.mjs`, not `src/`. `test/bundle.test.ts` rebuilds the server in
memory and fails when the pack's own code in the committed file is not what `src/`
builds to, so rebuild and commit `app/server.mjs` with every change under `src/`. Build
in an install whose dependencies sit at the repository root: a checkout that links them
from elsewhere writes that path into the file's module comments, and the same test
refuses it (rewrite the prefix to `../../../node_modules/`).

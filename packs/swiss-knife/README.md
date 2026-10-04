# Swiss Knife

## What it is

A group of small useful things behind one switch: `present` shows you a file as a card in the thread,
the Viewer opens that file beside the conversation and lets you annotate it, and two stream rules stop
the agent mid-edit when it writes a code comment.

Replaces the separate Viewer and Ban Comments plugins; if you still have them installed the app removes them for you.

## What it contains

- **Tool `present`**, loaded eagerly. One parameter, `path`: a file path, or an array of up to 12 (a
  relative path is read from the session's working directory). The model gets one line per file
  (`Presented report.pdf (PDF, 41 KB).`) or a plain reason it was refused; the thumbnail goes to the
  card, never to the model. Its card is the built-in `presentation` card, declared in `plugin.json`.
- **The Viewer**, an artifactory (an MCP App; server `viewer`, started by `ai.insodimension.dimension/mcp.json`)
  with the tools `view_file` and `read_file_chunk`. It draws images, PDF, HTML, Markdown, Word, PowerPoint,
  Excel, text and code, audio and video, offline in a sandboxed frame, and annotates them with ONE annotation
  toolbar per file kind, always shown (no mode to switch on, no Done): pins, boxes, circles, arrows and freehand on a
  picture or on a video frame, comments on text, a pick of an element on a page, a moment or a stretch of a
  recording (on a waveform for audio, on a filmstrip for video). A file opens behind one continuous opening surface
  instead of a flash. The card's Open and Annotate buttons come from the `opens` rows in `plugin.json`. Depth: `viewer/README.md` in this plugin's folder.
- **Two stream rules**, `ban-comments` (`.ts .tsx .js .jsx .rs .go`) and `ban-comments-python` (`.py`).
  When the agent writes a code comment in an `edit` or a `write`, the engine stops that output, tells the
  model to delete the comment and carry its meaning in names, types and structure, and the model writes
  the line again. Directive comments stay (`@ts-`, `eslint-`, `# noqa`, `#!` and the like). To turn them
  off alone, add both names to the `ttsr.disabledRules` setting; it belongs to the `ttsr` plugin (on by
  default), so it works only while `ttsr` is enabled, and with `ttsr` off the rules still fire. A
  same-named file in `.inso/rules/` overrides their text instead.

No skills or prompts (a test keeps those out).

## Who can use it

Anyone on the canary release ring (`channel: "canary"`); a stable install neither lists nor installs it.
It is on once installed, in every space (`modelSpaces` is empty and it declares no `spaces`, so it has no
audience to narrow it), and needs Dimension 0.10.24 or later, the first release whose engine honours the
rules' `except:` field. No sign-in, CLI or key.

There is one switch. Turning Swiss Knife off turns off `present`, the Viewer and the comment rule
together; none can be switched on its own. No agent is offered `view_file`: a person opens a file from
a `present` card or an Open button, and the Viewer is not a tool the model calls.

## Limits and risks

- **`present` never writes.** Its approval class is `read`. It refuses secrets (credential folders such
  as `.ssh`, `.aws`, `.git` and any folder named `locker`, `.env` files, private keys, token and cookie
  stores, the engine's own state; on Windows also network, device and alternate-data-stream paths), on
  the path as written and on its real path, naming a category and never content. The Viewer uses the
  same table, `viewer/src/fence.ts`. Regular files only; paths past the first 12 are reported, not
  presented; an image is read whole only up to 25 MiB and 25 megapixels.
- **The Viewer reads only what it is lent**: the vault, folders in `VIEWER_ROOTS`, and the one file a
  person clicks Open on. Recordings are read whole up to 64 MiB. An HTML page is never run; picking an
  element runs a second frame under a CSP that admits one script. Pick is in hand from the first frame
  for a page of 2 MiB or less; a larger page starts with Pick down, so its second copy is made only when asked for.
- **A waveform exists for a WAV or a strict MP3, and nothing else.** Drawing one decodes the whole recording, and
  a container's header can lie about its length (a 110 KB FLAC with a patched header decoded to 200 MB), so the
  decoder is only handed a file whose size the bytes themselves prove: a WAV judged on its own header, or an MP3
  whose frames are counted from the bytes (the first frame at byte 0 or right after a verified ID3v2 tag, no other
  container's magic in the first 16 bytes, frames unbroken to the end, at most 545 s and 32 MiB, and the player's own
  length must agree). One decode at a time, 96 MiB of samples at most. Ogg, FLAC, MP4 and M4A, WebM, AIFF and AAC
  still play; they get a flat track, and notes work the same on it.
- **Accepted residual risks**, each needing an agent that can already write to the disk: a hard link to
  a secret under a harmless name is not seen; a link to a missing target and one to a protected target
  answer differently; a path swapped for a link between the check and the open is opened as the link
  says (its type is re-checked).
- **The comment rule reads text, not code**: a `//` inside a string literal can trip it, and each hit
  costs the model one rewind and a rewrite.
- **Context cost.** `present` is in context on every turn: a budget of 115 tokens, held by
  `test/context-cost.test.ts`. The rules cost 0 until they fire (the engine files a stream rule as
  resident 0); the same test runs the engine's own bucketing to prove neither is a prompt rule.

## Build and test

```sh
bun run build        # dist/index.mjs (present), then viewer/app/server.mjs and viewer/app/dist
bun run test         # bun test test/ viewer/test/
bun run check:types  # both tsconfigs
```

The host loads the committed bundles, not `src/`: `test/bundle.test.ts` and `viewer/test/bundle.test.ts`
fail when a committed file is not what its source builds to, so rebuild and commit with every change.

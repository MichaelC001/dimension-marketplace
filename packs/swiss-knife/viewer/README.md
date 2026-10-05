# Viewer

A tabbed document viewer beside the conversation (an artifactory, doc 45): images,
PDF, HTML, Markdown, Word, PowerPoint, Excel, plain text, audio and video, rendered
offline in a sandboxed frame. It is one part of the Swiss Knife plugin (`../README.md`): this
folder is the deep reference. The View is `app/view` (built to `app/dist`); the MCP server is
`src/` (bundled to `app/server.mjs`). Both built files are committed.

## Tools

| Tool | Who calls it | Does |
|---|---|---|
| `view_file { path, filename?, annotate? }` | the host on a click (the plugin declares no `modelSpaces`, so no agent is offered it) | Resolves `path` through the fence and mounts the View on it. `annotate: true` picks the annotation tool up as the file opens (the drawing tool last held on a picture or a video frame, Box if none; Pick on a page, which matters for a page too large to start with it in hand) and is ignored for a kind with nothing to annotate. The tools themselves are there either way: an annotatable kind shows its bar from the pane's first frame. |
| `read_file_chunk { path, offset, length }` | the View only (`visibility: ["app"]`) | Streams a file's bytes to the View, at most 4 MiB a call. |

## What `opens` declares

The plugin's `plugin.json` (one folder up) declares, beside `mcpServer`, what this viewer can open from outside
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
| HTML | html, htm, xhtml | `element` |
| Audio | mp3, wav, flac, ogg, oga, opus, m4a, m4b, aac, weba, mka | `timeline` |
| Video | mp4, m4v, mov, webm, ogv, mkv | `timeline` |

`annotates` is a promise the View keeps: `marks`, `text`, `element` and `timeline` are the
four models the View's annotate layer implements (`@dimension/mcp-app-kit/annotate`,
docs 85 and 88), and the host offers Annotate on a card only for a kind a declared handler
covers.
Binaries and archives are not declared: the View shows them as a file card, which is
not "opening" them. `test/manifest.test.ts` holds the declaration to the SDK validator
and to the host's own `classifyFile` / `pickHandler`.

## Opening a file

A file opens in a new tab, which is a new iframe. Nothing of it may flash: the host holds an opaque, themed surface
over the iframe from the moment the tab exists until the View's handshake completes (`ArtifactOpening` in
`@fraym/ui`, the labor-illusion steps; doc 45), and the View shows the SAME component from its very first paint
(`McpAppShell`'s fallback) until the document is ready, so the host's surface hands over to the View's without a
blank frame or a different card. The steps are bound to real stages: **Connecting** (no tool result yet), **Reading**
the file (the bytes streaming in, with the real count of bytes read and a progress line), **Preparing** it (the
renderer chunk, loaded while the bytes stream, and the decode). The words wait 150 ms before they appear, so a
file that opens fast shows only the ground; when the document is ready the steps are marked done and the surface
fades out over it. A View told nothing yet shows Connecting, not "Nothing open": that statement comes only after
every document was closed, or 8 s with no tool result at all. A notice about a file that is not on screen floats
over the panes instead of pushing the one the person is looking at.

## Annotating: one toolbar per kind (docs 85, 88)

The header holds the kind badge, the file name, its size and the path copy: no mode pill, no Done button. Under it
an annotatable kind shows ONE annotation toolbar (named `Annotation tools`), the same component on every kind, from
the pane's first frame until the file is known not to have opened (an error, an unavailable or too-large file leaves
nothing to mark, and no bar, list or send button under the error card). There is nothing to click before drawing.
A drawing tool or Pick wears the accent ring while it is in hand; pressing it again, or Escape, puts it down, and the
person is browsing (scrolling, zooming, pinching, playing) again: a finger has no other way off an armed overlay.

| Kind | Tools on the bar | In hand on arrival |
|---|---|---|
| Image | **Pin, Box, Circle, Arrow, Draw** (keys `1`-`5`) · **Undo, Redo, Clear** | Box, so a drag draws at once |
| Text, Markdown, PDF, Word, PowerPoint, Excel | **Comment** (`Ctrl+Alt+M`) | Comment (the one tool of a text) |
| HTML page | **Pick**, **Whole page** | Pick, unless the page is over 2 MiB (below) |
| Audio | **Moment** (`M`), **Stretch** (`I` then `O`) | nothing to arm: notes go on the waveform |
| Video | **Moment**, **Stretch** · **Pin, Box, Circle, Arrow, Draw** · **Undo, Redo, Clear** | none: pick a tool to draw |

What a person adds is a **note** (the list is titled Notes). There is no send button and no row under the content: the
notes stage themselves in the composer a moment after the person stops changing them, a chip there is the
confirmation, and the person presses Enter in the chat. A warning or a refusal floats over the bottom of the pane;
removing every note takes the staged request back.

## Picking on a page (doc 88)

Pick lets a person point at part of a rendered HTML page; each pick joins the next
message as the element's selector, tag, text, a few attributes, four computed styles and its
box, with the human's note. **Whole page** picks `<body>`.

The page is **never run**. The reading frame is `sandbox=""`, as always. While Pick is in
hand the View builds a second frame from the same bytes with `sandbox="allow-scripts"` only, whose
document begins with a Content-Security-Policy that admits exactly one script, the
viewer's own picker, by its SHA-256, and denies every other script, handler,
`javascript:` URL, frame, object, base, form and connection. A canary script that the policy
must refuse runs first; if it ever runs, the picker declines and the reading frame comes
back with a plain sentence. The picker reports by `postMessage`; the View checks every
message (sender, origin, a per-mount channel, a closed set of types, exact keys, bounds)
and draws the outline, label and numbered badges itself. See doc 88 section 2 for why this
is the design and why the obvious one (reading the page directly) cannot work inside the
engine's sandbox.

**Pick is in hand from the first frame the page can be read**, so there is nothing to switch on, unless the page is
larger than `PICK_FRAME_LIMIT` (2 MiB, `app/view/document-bytes.ts`; a page of exactly 2 MiB still starts with Pick in
hand). The pick frame is a second copy of the page to parse and lay out, about the cost of the reading frame again,
and the viewer opens pages up to 128 MiB, far larger than anyone points at. A larger page opens with Pick **down**: the
bar says "Large page: press Pick to choose elements" (its tooltip says why), no second copy exists, and the pick frame
is built only when the person presses Pick or the card's Annotate. Escape, or pressing Pick again, puts it down (the page
is then only read and scrolled) and the second copy goes with it; Whole page is off while Pick is down.

Known limits, stated so nobody is surprised: putting Pick down and picking it up again opens the pick frame at the
page's top (the script-free reading frame's scroll cannot be read or set; a page that opens with Pick in hand has no
swap to suffer); clicks inside a page's own `<iframe>` go to that frame and cannot be
picked; shadow-root content picks its host element; an element inside `<head>` is not
drawn and cannot be picked; a rotated element is outlined by its bounding box; a selector
that cannot be made unique is flagged with how many elements it matches.

## Recordings (doc 88)

Audio and video play in the viewer: a transport (play, the lane, the time, volume, speed),
keyboard control (Space, arrows, Home/End, `,` and `.` to step a frame). The lane under the transport is the
kit's `WaveLane` for a sound and `FilmLane` for a video (`mcp-app-kit/README.md`), and it is both the control that plays
and the place the notes sit. The annotation toolbar's **Moment** (`M`) puts a note at the playhead and **Stretch**
(`I` sets where it starts, `O` where it ends, Escape takes a half-set one back) puts one on a span; a span can also be
dragged out on the lane (Shift-drag on a waveform). A moment within a quarter second of a note that is there focuses that one instead of stacking.
Up to 24 notes. The request lists them in time order, and for video carries up to four pictures (below).

* Files are read whole and capped at **64 MiB**; the size is checked before any byte is
  read, and a larger file says so and offers Copy path.
* The kind comes from the file's container signature (content beats a wrong name), and a
  file the viewer cannot decode says so honestly instead of showing a blank player.
* **Audio is a waveform you can comment on.** The lane draws dense rounded bars mirrored about a baseline (the played
  part in the accent colour), a click or drag seeks, and **a double-click on the wave, or the Comment button at the
  playhead, adds a note at that time with a field right there** (Enter saves, Escape cancels); Shift-drag selects a
  stretch. Notes are numbered pins on the top edge, in the order and with the numbers of the Notes list; hover or focus
  one to read it, Enter edits it. Audio has no drawing: there is no picture to draw on.
* **A waveform exists only where its cost can be bounded from the file's own bytes.** Making one decodes the whole
  recording to samples, and a container's header can lie about how long it is (a 110 KB FLAC whose header was patched
  decoded to 200 MB, a 640 KB one to 1.2 GB), and the player's `duration` is that same header's word again. So the
  decoder is handed only two kinds of file: **an uncompressed WAV** (PCM or float), judged on its own `fmt ` and `data`
  chunks checked against the bytes really there; and **a strict MP3**, whose frames are walked end to end so the length
  is counted from the bytes (an Xing header that claims ten seconds of a file holding an hour is never read). Strict
  means: the first frame is at byte 0 or exactly where a verified ID3v2 tag ends, no other container's magic
  (`OggS`, `fLaC`, `ftyp`, `RIFF`, `FORM`, EBML) is in the first 16 bytes of the audio, three frames of one stream
  follow each other and the frames run unbroken to the end (at most 16 KiB of tag after the last), the walk is
  at most 545 s, and the player's own length agrees with the count (within the larger of 1 s or 5 %). Everything else,
  Ogg, FLAC, MP4 and M4A, WebM, AIFF, raw AAC, a compressed WAV, an MP3 that is not strictly one, **gets a flat track**:
  no decode, no waveform, no cost, and no fake wave. Notes, pins and seeking work the same on it.
* **The caps.** A file over 32 MiB gets no waveform (the decode needs its own copy); samples are held at 22.05 kHz, at
  most 8 channels and 96 MiB at once, which for a stereo 44.1 kHz MP3 means about 190 s (545 s is reached only by mono
  at 24 kHz or less); after the decode the result is checked again against the same caps and against the player's
  length, and a sound that is not the one the file promised is dropped. **One decode at a time**, in a queue the whole View
  shares: a decode cannot be cancelled, so three panes opening three recordings would otherwise hold three at once. It
  starts only for the tab on screen once the file is ready and its length is known, and the work after the decode runs
  in slices of about 6 ms that give the thread back.
* **Video is a filmstrip you can draw on.** Under the picture the lane shows a time ruler and up to 16 frame
  thumbnails spaced in proportion to time (about one per 96 px of width, fewer when narrow), the playhead through them
  and the notes on top (a pin for a moment, a rounded square for a drawing, a bracket for a stretch); a click seeks and a drag selects a
  stretch. The thumbnails are taken lazily once the pane is ready and on screen, one after another through a silent second
  element (the player never moves), abortable, small (long edge 160 px, JPEG 0.7), each fading in as it arrives;
  a frame that cannot be taken stays a neutral placeholder and never fails the pane. They are cached per file (4 files,
  48 pictures each), so a theme change does not take them again.
* **Drawing on a frame.** The picture is an image, so the toolbar's Pin, Box, Circle, Arrow and Draw (keys `1`-`5`)
  work on it once one is picked (none starts in hand, so a click on the picture still plays and pauses it). The first
  press on the picture pauses the film, because a box on a frame that has gone is a box on the wrong picture. A drawing
  is a note on that one frame (its time is the frame's start), shows only while the playhead is on that frame, and sits
  over the picture the video actually draws (letterbox bars excluded). The Notes row reads `0:05.2 · box`; **Go to** on a drawing pauses on its frame. Escape takes back a half-set stretch first and
  then puts the tool down.
* **What a send carries for video.** Pictures are taken at send time from the silent element (long edge 768 px, JPEG
  0.82) inside the host's image caps (4 images; 2 MiB each, 4 MiB together). **Frames you drew on come first**, one
  picture per frame however many drawings are on it, with the shapes burned in and numbered by the same number the
  note has in the Notes list and the text; the slots left over go to plain moments in time order. A drawn frame with no
  room, no host image door or a frame that could not be taken goes as boxes and a time in the text, and the human is
  told.
* A recording that does not report its length is resolved with one seek; if that fails,
  marks use the time you hear and the transport says so.

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

## Limits, in one place

| What | Limit | Where it is held |
|---|---|---|
| A recording the viewer plays | 64 MiB, checked before any byte is read | `MAX_MEDIA_BYTES` (`src/contract.ts`) |
| Any other document | 128 MiB (text: the first 1 MiB) | `DOCUMENT_LIMIT`, `TEXT_LIMIT` (`document-bytes.ts`) |
| An HTML page that starts with Pick in hand | 2 MiB; larger starts with Pick down | `PICK_FRAME_LIMIT` (`document-bytes.ts`) |
| A waveform | WAV or strict MP3 only; file 32 MiB, decoded 96 MiB at 22.05 kHz, 8 channels, MP3 545 s; one decode at a time; everything else a flat track | `media-waveform.ts` |
| A video filmstrip | 16 thumbnails, 160 px long edge; 4 files cached | `MAX_FILM_SLOTS`, `media-frame.ts`, `media-filmstrip.ts` |
| Notes on one file | 24 | `MAX_MARKS`, `MAX_COMMENTS`, `MAX_ELEMENT_PICKS`, `MAX_TIMELINE_MARKS` |
| Pictures in one request | 4, 2 MiB each, 4 MiB together | the host's image caps, held by the kit |

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

Run both from the plugin root (`marketplace/packs/swiss-knife`), not from this folder.

```sh
bun viewer/scripts/build.mjs   # viewer/app/server.mjs and viewer/app/dist (validates ../plugin.json with the SDK first)
bun test ./viewer/test/
```

`bun run build` there builds `present` too. The host runs `app/server.mjs`, not `src/`.
`test/bundle.test.ts` rebuilds the server in memory and fails when the code in the committed
file is not what `src/` builds to, so rebuild and commit `app/server.mjs` with every change
under `src/`. The build writes every dependency path in the file as
`../../../../node_modules/` (this folder's distance to the repository root), whatever install
built it, and the same test refuses any other spelling. `src/fence.ts` also holds the plugin's
one deny table: `present` imports it, so a change to it changes both tools.

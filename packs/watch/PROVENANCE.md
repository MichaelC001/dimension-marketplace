# Provenance — the `watch` plugin

**Status change (2026-08-12): this is no longer a read-only vendor.**
`skills/watch/scripts/` used to be a byte-for-byte copy of
[bradautomates/claude-video](https://github.com/bradautomates/claude-video)
v0.2.0. The engine under `scripts/` is now **original work**, and the plugin
registers its own `watch` tool. The upstream MIT notice is preserved below
because the original vendor happened and the design lineage is real.

## Why the vendor policy was abandoned

The previous `VENDORED.md` said: *"Fixes and version bumps flow from upstream
into this copy, they are not authored here."* That policy assumed a live
upstream. Measured on 2026-08-12:

- Last upstream commit: **2026-06-30**; last release **v0.2.0, 2026-07-01**.
- **0 of 93 pull requests merged.** Ever. 16 closed unmerged, 77 open.
- 99 open issues, including the same one-line `-vsync` fix filed **four times**
  (#101, #117, #122, #126) with a verified patch offered and ignored.

Fixes cannot flow from a repository that merges nothing. Holding the policy
meant shipping known defects indefinitely.

## Defects the vendored copy shipped

All three were present in this package before 2026-08-12 and are fixed now.

| Defect | Where it was | Consequence |
|---|---|---|
| `-vsync vfr` | `frames.py:256`, `:615` | ffmpeg 9 removed the flag; **every** frame extraction failed with `Unrecognized option 'vsync'`. |
| No sanitization of media text | all of `scripts/` | The transcript printed inside a bare ``` fence with no label. A caption line containing three backticks closes it, so uploader-authored text reads as report prose. Prompt-injection surface in a shipped product. |
| `rm -rf <dir>` in the contract | `SKILL.md:197` | The skill instructed the agent to recursively delete a path from its own output. |

The injection hole was the serious one: yt-dlp prefers **manual** subtitles, and
a manual caption track is free-form text the uploader typed. Full analysis and
the adversarial fixture: [`skills/watch/references/threat-model.md`](skills/watch/references/threat-model.md).

## What the rewrite changed

- `scripts/safety.py` — new. Fence sizing (`longest backtick run + 1`, which is
  what CommonMark actually requires), sentinel-forgery scrubbing, invisible and
  bidi character stripping, exotic line-terminator normalization, length budget.
- `scripts/media.py` — behavioural capability probes rather than assumptions:
  `-fps_mode` vs `-vsync` (ffmpeg 8.1.2 still accepts `-vsync`, so a version
  check would misfire in both directions), and `ffprobe` executability with an
  `ffmpeg -i` banner fallback for machines where an Application Control policy
  blocks one binary and allows its sibling. UTF-8 pinned on every subprocess.
- `scripts/transcript.py` — captions → **local** Whisper CLI → cloud, where the
  cloud step needs a key **and** `--allow-remote-transcription`. Upstream
  uploaded audio whenever a key happened to exist. Also fixes YouTube's rolling
  auto-caption duplication by comparing whole lines against the last line kept.
- `scripts/watch.py` — manages and prunes its own run directories, so no
  contract anywhere needs to instruct a recursive delete.
- `index.ts` — new. Registers the `watch` tool, which is what earns the plugin a
  bespoke tool card (the renderer registry keys on tool name; a skill shelling
  out through `bash` has no key to bind).

## Design lineage

The core insight — a video is *N JPEGs plus a timestamped transcript*, and the
agent already has an image-capable read tool — is Brad Bonanno's, and it is a
genuinely good one. Caption-first acquisition, the duration-scaled frame budget,
the 2 fps ceiling, and thumbnail-difference deduplication all originate upstream
and are reimplemented here rather than invented.

Two mechanisms were adopted after reviewing
[abe238/claude-video-plus](https://github.com/abe238/claude-video-plus), the
maintained fork: local-first transcription, and treating media-derived text as
an injection surface. That fork reached the same conclusion independently and
earlier; the implementation here is our own.

## Upstream license

The original work is MIT and the notice is reproduced in full as required.

```
MIT License

Copyright (c) 2026 Bradley Bonanno

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

The read-only clone at `research-clones/claude-video` remains untouched and is
still the reference for comparing against upstream.

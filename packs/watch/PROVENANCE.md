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

## Upstream re-review, 2026-10-28 (v0.3.0 – v0.3.2)

The measurement above is a snapshot: upstream released v0.3.0, v0.3.1 and
v0.3.2 on 2026-09-25, after it. The policy is unchanged. Nothing is vendored;
each upstream fix is read against *this* engine and either reimplemented here
or recorded as skipped with the reason.

**Ported, as our own implementations**

| Upstream | Here |
|---|---|
| Only the latest yt-dlp is supported; update on HTTP 403 (fdbffd1) | Extended. Upstream tells the agent to update and retry once. `scripts/ytdlp.py` does it: on an `ERROR:` line that is a 403 or sign-in refusal it runs `pip install -U yt-dlp` once and retries the command once. |
| yt-dlp found on PATH | Replaced. `pip install yt-dlp` puts `yt-dlp.exe` in a `Scripts` directory that is usually not on PATH, so a PATH lookup failed on a machine where the install had succeeded. `ytdlp.py` runs `python -m yt_dlp` under the engine's interpreter when the module is importable, else the PATH executable, else installs it into that interpreter (`--user`, or the virtual environment itself; no shell; 240 s bound; output through `safety.labeled_diagnostic`). Only `ffmpeg` is a user prerequisite now. |
| Actionable probe/launch errors | `scripts/proc.py`: an unlaunchable binary (WinError 4551, missing execute bit) becomes a named, actionable exit instead of a traceback. Every subprocess in `media.py`, `transcript.py` and `ytdlp.py` goes through it. |
| RGB thumbnail deduplication | Reproduced first: the gray 16×16 thumbnail merged flat `#C83C3C` and `#3C833C` slides (same luminance), deleting one. `media.dedup` now compares `rgb24` thumbnails at the same threshold. |
| WebVTT cue/block parsing, entities, BOM | `transcript.parse_captions` reads a cue as the block under its timing line up to the next empty line, decodes entities after stripping tags, and ignores a UTF-8 BOM. Measured on two real YouTube auto-caption files: identical output on one; on the other the old digits-only filter had dropped the spoken `20` of "at least 20 hours". |
| Overlap-scoped deduplication of repeated cues | `_collapse_rolling` only collapses a repeated line that starts within `ROLLING_GAP_SECONDS` (0.25 s) of its previous showing. YouTube's repeats are contiguous (a 10 ms cue starts where the last ended), so real rolling captions collapse exactly as before; the same words said again after a pause are kept. |
| Fresh run directories, no stale or partial media reuse | Adapted. A fresh run directory was already the default; a reused `--out-dir` kept its old `video.*`, so a failed fetch could analyse the previous video under the new URL. `media._clear_stale_media` removes media and partials (not captions or info) before a download. |
| Captions survive media/probe failures | `watch.py` keeps a transcript it already has when the video download fails and says so in a `Frames unavailable` note, rather than discarding it. |
| Prefer English captions when the source language is unknown (285d7f4) | Adapted. This engine asks yt-dlp for `en.*` only, so a non-English track can never be chosen. The same ordering bug existed among the English variants: alphabetical order put `en-orig` and `en-GB` ahead of a plain `en`. `media._pick_subtitle` ranks `en`, `en-orig`, `en-US`, `en-GB`. |
| UTF-8 on Windows | Already pinned on every subprocess, info-JSON and caption read, and on stdout. Added: one shared helper (`proc.py`), `utf-8-sig` caption reads, and `PYTHONUTF8=1` in the yt-dlp child so its own stderr is UTF-8 on a pipe. de8b5b5 itself only changes upstream's tests. |

**Skipped**

| Upstream | Why |
|---|---|
| `-fps_mode` detection in FFmpeg 9 help output (c1975ef) | Our probe never reads `-h full`. It runs a 50 ms lavfi encode with `-fps_mode vfr` and keeps the answer, so the help format cannot matter. |
| SKILL.md frontmatter within the Agent Skills spec (4576273) | Already compliant: `name` and `description` only (676 of 1024 characters). A pack test now guards it. |
| Gemini engine (routes the video to Google's model, uploading it) | Left out. A cloud upload path conflicts with this pack's consent rule: no media leaves the machine without `allowRemoteTranscription`. |
| Managed WhisperX (uv-built Python 3.12 environment, model warm-up) | The ladder uses a local Whisper CLI only when one is already installed and never installs one. |
| Setup wizard, `config.py`, `.env`, cookie options, `--sub-lang`, hooks | The host's connect flow and the tool schema replace them. |
| Original-language caption selection and provenance | A feature, not a fix: this engine requests English only. Known gap: a non-English video with no English track gets no captions and falls through to local speech-to-text or "unavailable". |
| Whisper audio chunking, 24,000,000-byte budgets | Over-limit audio is refused with a pointer to `--start`/`--end`, by design. |
| Bounded caption downloads | yt-dlp's own socket timeout and retries, plus the tool's 10-minute process-tree kill, already bound the step. Only the pip install carries a bound of its own. |
| Full-track caption check before focus filtering | Already so: the whole track is parsed and `filter_range` applies afterwards. |
| Workflow, CI, README and release commits | Not part of this package. |

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

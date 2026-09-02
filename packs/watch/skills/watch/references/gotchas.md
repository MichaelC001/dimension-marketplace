# Gotchas — watch skill

Append-only LOG of one-off learnings from real runs. Each entry is 1–3 lines. The fix lives in the promoted reference — entries here are breadcrumbs.

**Format:**
```markdown
### YYYY-MM-DD — <one-line title>
Symptom → cause → fix. See [<promoted-ref>#<anchor>](<promoted-ref>#<anchor>) for the full pattern.
Context: <what you were doing>.
```

---

### 2026-08-12 — A nonce in the fence info string is not a fence defense
Assumed ` ```untrusted-<nonce> ` was safe → CommonMark closes a fenced block at the first line whose backtick run is at least as long as the opener, ignoring the info string → size the fence to `longest run + 1` instead. See [threat-model.md](threat-model.md#1-fence-length-not-a-nonce).
Context: designing `safety.wrap_untrusted` for the transcript block.

### 2026-08-12 — `-vsync` removal is a build fact, not a version fact
ffmpeg 9 rejects `-vsync`, but local ffmpeg **8.1.2 accepts it** (verified), so a version comparison would mis-fire both ways → probe behaviourally with a 50 ms lavfi run and cache. See [pipeline.md](pipeline.md#portability-notes).
Context: avoiding the bug that has broken upstream `claude-video` since 2026-07-27 across four duplicate issue reports.

### 2026-08-12 — `shutil.which()` cannot see an Application Control denial
Windows WDAC blocks `ffprobe.exe` while allowing `ffmpeg.exe` from the same folder; `which()` finds the file, then `subprocess` raises `OSError` (WinError 4551) → probe by executing, and fall back to parsing the `ffmpeg -i` banner. See [pipeline.md](pipeline.md#portability-notes).
Context: hardening metadata probing against reported Windows failures.

### 2026-08-12 — `<img src="x.svg">` is an isolated document, so `currentColor` is black
Icon rendered pure black standalone while looking correct inlined → an SVG loaded through `<img>` inherits nothing from the host page → paint with `var(--fr-accent, #b78cff)`. A root `color=""` attribute also fixes standalone but **beats inherited CSS**, silently breaking accent switching — verified by an amber swatch that stayed violet.
Context: building `assets/watch-icon.svg`; caught only because the preview was actually rasterized and looked at.

### 2026-08-12 — `--` is illegal inside an XML comment
The icon rendered inline but showed a broken-image glyph via `<img>` → an explanatory comment contained a literal `--`, which XML forbids; HTML parsing is lenient, the SVG/XML parser is not → sanitize comment bodies. Verified afterwards with `xml.etree.ElementTree.parse`.
Context: documenting the accent-token decision inside the SVG itself.

### 2026-08-12 — Windows Store `python.exe` honours a Linux shebang
`python scripts/generate.py` in the `image-gen` skill failed with `No runtime installed that matches 3.13` even though `python --version` reported 3.14.3 → the PyManager shim parses the script's `#!/home/inso/miniconda3/bin/python3.13` line → invoke the real interpreter path directly.
Context: attempting to generate the skill's card art (blocked separately by an exhausted OpenAI quota).

### 2026-08-12 — ffmpeg's default CFR sync silently ate the dedup thumbnails
Dedup reported `0 dropped` on twelve IDENTICAL frames → stills fed through the `concat` demuxer share a PTS and default CFR sync drops the duplicates, so only 4 of 12 thumbnails came back and the short-blob guard bailed out silently → add `-fps_mode passthrough` (probed) and make the guard warn. See [pipeline.md](pipeline.md#deduplication).
Context: first real dedup test; a two-tone clip passed by luck because scene detection found exactly 2 cuts and dedup never ran. Only a single-tone clip forced the uniform path and exposed it.

### 2026-08-12 — A green test that never executed the feature is not evidence
The two-slide fixture "passed" (2 frames, correct) while dedup was completely broken → scene detection short-circuited the code path under test → pick fixtures that force the specific branch, and assert the branch ran (`N near-duplicates dropped`), not just that output looked sane.
Context: verifying dedup; generalizes to every fallback path in `select_frames`.

### 2026-08-12 — Windows `python` on PATH is the Store alias: exit 53, zero output
The plugin tool spawned `python` and got exit 53 with empty stdout AND stderr → bare `python`/`python3` resolve to the Microsoft Store *app execution alias* in `WindowsApps`, which satisfies every which-style lookup then refuses to run non-interactively → probe candidates by EXECUTING `-c "print(sys.version_info[0])"`, and on win32 also enumerate `%LOCALAPPDATA%\\Python\\*` and `%LOCALAPPDATA%\\Programs\\Python\\*`. `INSO_WATCH_PYTHON` overrides. See [pipeline.md](pipeline.md#portability-notes).
Context: first run of `index.ts`; it worked from git-bash because that PATH ordering finds a real interpreter first, so the shell test did NOT predict the spawn.

### 2026-08-12 — Ad-hoc `tsc` on a plugin reports errors that are not yours
`bunx tsc --noEmit index.ts` flagged 23 errors in the new plugin → without the repo tsconfig the DOM/node libs conflict → run the SAME command on a known-good shipped plugin before believing it: `packages/model-intel` produced 45 of the identical class. `biome check` is the canonical gate for these packages (no root tsconfig exists).
Context: verifying the watch plugin; nearly chased phantom type errors.

### 2026-08-12 — `-frames:v <cap>` TRUNCATES a video, it does not sample it
A 5:49 montage at `balanced` reported "100 frames, full range" but its last frame was 04:39 — 70s never sampled → passing the frame cap to ffmpeg makes it early-exit at the first N scene cuts, so `select_frames`' even-sampling never sees the tail → detect against a high `CANDIDATE_CEILING` and let the post-hoc even-sample apply the cap. Verified: 100 truncated candidates/last 04:39 → 113 detected/last 05:30. See [pipeline.md](pipeline.md#deduplication).
Context: watching a real video for the owner; the report's own "full range" wording is what made it invisible.

### 2026-08-12 — A hue filter finds pixels, not subjects
Ranking frames by orange pixel share to locate an "orange tree" put SUNSETS in 8 of the top 10 — warm light saturates every surface → treat a colour prescan as a CHEAP SHORTLIST, then confirm each hit visually before citing a timestamp. Cut 113 frames to 14 reads, but the top hit by percentage was the wrong answer.
Context: temporal visual search on the Ghost of Tsushima montage.

### 2026-08-12 — Sanitizing the happy path is not sanitizing
Claimed uploader text could not reach the model unlabeled; a security review proved it could, via the ERROR channel — ffmpeg at `-loglevel info` prints the input container's stream metadata, and the tool threw the raw stderr tail → route every diagnostic through `safety.labeled_diagnostic()` (single line, so a tail-slice cannot strip the label). See [threat-model.md](threat-model.md#6-the-error-channel--the-one-that-got-missed).
Context: PR #228 review. The defense existed and was correct; it simply was not on the path an attacker would pick.

### 2026-08-12 — Enumerating invisible-character ranges by hand is the bug
`_INVISIBLE` listed ranges and a review split the sentinel with NINE characters, four of them category `Cf` — the exact class the docstring claimed to cover (SOFT HYPHEN, the U+E0000 tag block, VS-16, ARABIC LETTER MARK) → strip by `unicodedata.category`, and match the sentinel on an NFKC + confusable-folded copy with an index map back to the original. See [threat-model.md](threat-model.md#2-sentinel-forging--matched-on-a-folded-copy).
Context: same review; the hand-list looked exhaustive and was not.

### 2026-08-12 — A regex that demands a field the writer omits fails silently
Local Whisper returned zero segments while reporting success → the cue regex required `HH:`, but openai-whisper's VTT writer sets `always_include_hours = False`, so sub-hour audio emits `MM:SS.mmm` → make hours optional and parse both shapes. Verified against VTT-with-hours, VTT-without, and comma-separator SRT.
Context: PR #228 review found it by reading whisper's own `utils.py` rather than trusting the parser.

### 2026-08-12 — `child.kill()` orphans the grandchildren
A timeout or cancel killed the Python wrapper while yt-dlp/ffmpeg kept downloading and writing frames → kill the TREE (`taskkill /t /f` on Windows, negative-pid `SIGKILL` on POSIX with `detached: true` so the group exists).
Context: PR #228 review.

---

## Append-only rules

1. **Promote BEFORE you append.** The full fix lives in the appropriate reference; the entry here is the breadcrumb.
2. **Use absolute dates** (the user's current date). Never relative.
3. **One entry per discrete learning.** If a single run surfaces 5 things, log 5 separate entries.
4. **Never edit existing entries.** This is an audit log of what the skill learned and when. Strikethrough or supersede with a new dated entry instead.
5. **User pushback is the highest-value gotcha source.** If the user corrected you on phrasing or methodology, that's a must-log moment.

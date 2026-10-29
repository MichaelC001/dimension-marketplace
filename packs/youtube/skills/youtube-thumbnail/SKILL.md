---
name: youtube-thumbnail
description: "Design three 1280x720 YouTube thumbnail variants for a finished film as HyperFrames compositions, render them as stills with the motion pack, check them against YouTube's overlay zones and at phone size, and record them in receipts/publish.json. Use when a title is chosen and someone says make the thumbnail, design the cover, give me thumbnail options, or set up a thumbnail A/B test. Not for the title or description (youtube-package) or the upload (youtube-studio-upload)."
---

# YouTube thumbnail

Three thumbnails that differ in idea, built as flat HyperFrames compositions, rendered to stills with the motion pack, and recorded with their measurements in `receipts/publish.json`. There is no image tool in this job: a thumbnail is the same kind of graphic as any other in the film, so it goes through `motion_new`, `motion_write_file`, `motion_lint` and `motion_frames`.

`<SKILL_DIR>` is the folder this SKILL.md is in. Scripts run with `node` (22 or newer) or `bun` and need `ffmpeg` on the PATH (or `FFMPEG=<path>`). The compositions and the template are in [references/composition.md](references/composition.md); read it before the first write.

## Before you start

- `receipts/publish.json` exists with a chosen title (run `youtube-package` first). The thumbnail and the title are one message in two places: the thumbnail adds the hook the title does not say, so you need the title.
- The film's strongest frames and its claim list. A thumbnail shows something the film shows.
- The motion pack's tools: `motion_new`, `motion_write_file`, `motion_lint`, `motion_frames`, and `motion_attach` for a picture from the film. If `motion_frames` says the browser is missing, run `motion_setup` and ask the person before the download it names.

## What YouTube says, and what others measured

**YouTube** (help answer 12340300): 90% of the best-performing videos have a custom thumbnail. Keep it simple, make it large, use a font that is easy to read, and apply the rule of thirds. Too much colour and composition overwhelms. A thumbnail has to give the viewer an accurate glimpse of the video; a misleading one counts as spam (answer 2801973). Studio's A/B test takes up to three (answer 16391400).

**Third parties**, to break ties and not to overrule the film: 500 breakout videos studied by vidIQ had a face 69% of the time and a face or high contrast 89% of the time, with a median of 5 words of text (guidance 3 to 5; this skill allows 4). ThumbnailPeak measured where YouTube draws over a thumbnail on 2026-10-21 (below).

## Order of work

1. **Brief.** One concept, the focal subject, the words (up to 4, not just the title again), two or three colours with their hex values, the feeling you want. Write it into `thumbnail.brief`: `concept`, `focalSubject`, `text`, `palette`, `emotion`.
2. **Compose three.** `motion_new` each as `thumb-a`, `thumb-b`, `thumb-c`: width 1280, height 720, fps 30, durationSeconds 1. Replace `index.html` with `motion_write_file` using the flat-layer template. The ideas to vary: subject-led (a), typographic (b), concept or contrast (c). Rules in [references/composition.md](references/composition.md).
3. **Lint.** `motion_lint` on each: zero errors and the browser check must have run. Fix and repeat.
4. **Look.** `motion_frames` with `atSeconds: [0.5]`. Read the image. Does it say one thing?
5. **Zones.** For each: `node <SKILL_DIR>/scripts/thumbnail-pack.mjs zones <out.png> <still>`, then look at the copy. Any word or face under a shaded box is a fix.
6. **Phone.** `node <SKILL_DIR>/scripts/thumbnail-pack.mjs phone <sheet.png> <a> <b> <c>` (a new file name each time), then look. At 168 px wide you must be able to read each word and name each subject. Only then is `phoneCheck` true.
7. **Measure.** `node <SKILL_DIR>/scripts/thumbnail-pack.mjs inspect <a> <b> <c>` gives size, bytes, sha256 and whether there is an alpha channel; a problem is listed in `problems`. Over 2 MB: `encode <in> <out.jpg>`.
8. **Record.** Add `thumbnail.variants[]` (`id`, `role`, `path` under `renders/`, `format`, `width`, `height`, `bytes`, `sha256`, `phoneCheck`, `composition`), `thumbnail.chosen`, and `thumbnail.abTest` when the person wants a test. Write the file, then `node <SKILL_DIR>/../youtube-package/scripts/publish-check.mjs check <production-dir>` with no `--stage`; it re-reads the files and refuses a variant changed since it was measured.
9. **Pick with the person.** Show the three at phone size with the title beside them and say which you would ship and why in one sentence. They choose; `chosen` is theirs.

## Variants at a glance

| | Idea | Words |
|---|---|---|
| a | one nameable subject, the film's best picture | at most 3 |
| b | the words are the picture, flat field, 10:1 contrast | up to 4 |
| c | two halves: before and after, or this against that | one word per side |

## Overlay zones in a 1280×720 frame

Bottom-right x 930 to 1280, y 520 to 720 (the length badge): no word, no face. Top-left x 0 to 220, y 0 to 155 (a "New" label for a few days): no face or key word. Bottom y 676 to 720 (the watched bar): no text. Top-right is free: put a logo there. These are one third party's measurement of YouTube on one day. The playlist panel is lost to the badge whatever you do.

## Limits to say out loud

- **Resolution.** YouTube recommends the largest image you can, 3840×2160 (answer 72431). The motion pack's stills are 1280×720: above the 720p line below which an A/B test downscales every thumbnail to 480p, and past the 640 px minimum width, but not as sharp as YouTube asks for. A larger render is not something the motion tools offer yet.
- **A verified channel.** YouTube only lets a verified account upload a custom thumbnail (answer 72431). If Studio shows no upload control, that is the cause; tell the person and point at youtube.com/verify.
- **A daily limit.** YouTube caps custom thumbnails a day and answers "Daily custom thumbnail limit reached"; try again after 24 hours.
- **Mobile 2 MB.** The file limit is 2 MB on a phone and 50 MB on a computer; the gate holds the lower one.
- **A/B test conditions.** Desktop Studio, advanced features on, not Shorts, private or made-for-kids. The first thumbnail uploaded is the default when no variant wins, so it is the one in `thumbnail.chosen`.

## What you leave behind

Three stills under `renders/`, the compositions under `media/motion/thumb-*`, the variants and brief in `receipts/publish.json`, and an answer that shows the phone sheet and names the one you recommend.

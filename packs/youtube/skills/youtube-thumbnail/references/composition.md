# A thumbnail as a HyperFrames composition

A thumbnail here is a 1280×720 HyperFrames composition of one second that never moves, rendered to a still with `motion_frames`. Same toolchain as every other graphic in the film, no image model, nothing to install.

## The template

`motion_new` scaffolds a composition with a nested scene, which the linter warns about for a still. Replace the whole `index.html` with flat layers, one element per thing on the image. Every layer has an `id`, `class="clip"` and its own `data-start`, `data-duration` and `data-track-index`; the root carries the composition id, which must equal the name you gave `motion_new`.

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=1280, height=720" />
    <script src="./vendor/gsap.min.js"></script>
    <style>
      html, body { margin: 0; background: #0b0b0d; }
      #root { position: relative; width: 1280px; height: 720px; overflow: hidden; font-family: "Archivo Black", system-ui, sans-serif; }
      .layer { position: absolute; }

      .bg { inset: 0; background: #ffdd33; }
      .words { left: 64px; top: 184px; width: 1150px; font-size: 200px; line-height: 0.92; letter-spacing: -0.02em; color: #0b0b10; text-transform: uppercase; }
      .bar { left: 64px; top: 628px; width: 520px; height: 26px; border-radius: 13px; background: #0b0b10; }
    </style>
  </head>
  <body>
    <div id="root" data-composition-id="thumb-b" data-start="0" data-duration="1" data-width="1280" data-height="720" data-fps="30">
      <div id="bg" class="clip layer bg" data-start="0" data-duration="1" data-track-index="1"></div>
      <div id="words" class="clip layer words" data-start="0" data-duration="1" data-track-index="2">Cut<br>is data</div>
      <div id="bar" class="clip layer bar" data-start="0" data-duration="1" data-track-index="3"></div>
    </div>
    <script>
      window.__timelines = window.__timelines || {};
      const timeline = gsap.timeline({ paused: true });
      timeline.fromTo(".words", { opacity: 0.96 }, { opacity: 1, duration: 0.2, ease: "none" }, 0);
      window.__timelines["thumb-b"] = timeline;
    </script>
  </body>
</html>
```

Notes from building the test thumbnails:

- Keep the paused GSAP timeline the scaffold made and register it under the composition id; the motion pack seeks it to the time you ask for. A one-tween timeline is enough for a still.
- `motion_write_file` refuses any `http` URL, so no web font link and no remote image. Name a font HyperFrames bundles by its family: `Archivo Black` (used for the test thumbnails), `Inter`, `Montserrat`, `Oswald`, `League Gothic`. A family it does not bundle falls back to the system font and the render will differ from what you meant.
- A picture from the film goes through `motion_attach` (it copies the file into the composition and records its source), then `<img src="assets/<file>">`. Never an image from the web.
- Colour and contrast: `motion_lint` runs the browser check and reports text under WCAG AA. Run `node <SKILL_DIR>/scripts/thumbnail-pack.mjs contrast <text colour> <background>` when you choose colours: words need 4.5, a subject against its background 3.

## Where YouTube draws over a thumbnail

In a 1280×720 frame (third-party measurement of YouTube on 2026-10-21, so it can change; the shapes are rounded up):

| Zone | Box | Keep out |
|---|---|---|
| Length badge | x 930 to 1280, y 520 to 720 | every word, every face |
| "New" label beside a video, for a few days after upload | x 0 to 220, y 0 to 155 | a face or a key word |
| Watched bar | y 676 to 720, full width | text |
| Top-right | nothing covers it in any view measured | a logo goes here |

The playlist panel shrinks a thumbnail to 100×56 and the badge covers 43% of it; treat it as lost. `node <SKILL_DIR>/scripts/thumbnail-pack.mjs zones <out.png> <image>` shades the three zones over a copy: look at it and move anything that sits in a shaded box. (Shapes and backgrounds may run under a zone; words and faces may not.)

## The three variants

A/B testing in Studio takes up to 3 thumbnails, and YouTube says tests of near-identical options run long and end with no winner. Make the three differ in idea, not in colour:

| Variant | Idea | Built from |
|---|---|---|
| **a, subject-led** | one picture the viewer can name, and at most 3 words | a crop of the film's best frame, or the product's interface built as HTML (see the motion pack's `ui-closeup` skill), never a photo of a screen |
| **b, typographic** | the words are the picture: up to 4 words at the largest size that fits, on a flat field | one colour pair at 10:1 contrast or better |
| **c, concept** | a before and after, or this against that, a word on each side | two halves; the difference must be readable at 168 px |

Content rules for all three:

- **Words:** up to 4, and not just the title again. The gate warns when every word on the thumbnail is already in the title. YouTube suggests an easy-to-read font and warns that too much design overwhelms (answer 12340300). Third-party measurement of 500 breakout videos: the median was 5 words, so 4 is on the careful side.
- **A face**, if the film has a person on camera: large, eyes clear of the zones, taken from the film. Third-party measurement of the same 500 videos: 69% had a face and 89% had a face or strong contrast. Never a stranger's face and never a generated likeness of a real person.
- **Honest.** It shows something the film shows, and the words do not promise more than the title does. YouTube treats misleading thumbnails as spam. No fake play button, no fake interface chrome that is not the product's, no arrows pointing at nothing.
- **Flat.** One focal point and two or three colours. Complexity is the common failure at phone size.
- **One brief for all three:** concept, focal subject, the words, palette, emotion. It goes into `thumbnail.brief` once.

## Checking

1. `motion_lint` on each: 0 errors and the browser check ran.
2. `motion_frames` with `atSeconds: [0.5]` per composition. The tool shows you the image and writes `renders/frames/motion-<name>-<stamp>-0.png`.
3. Copy each PNG to `renders/thumbnails/<production>-<id>.png` with a shell (`cp`), or use the frames path as it is: a variant's `path` only has to sit under `renders/`.
4. `node <SKILL_DIR>/scripts/thumbnail-pack.mjs inspect <images...>`: size 1280×720, bytes, hash, and no alpha. A PNG over 2 MB: `encode <in> <out.jpg>` finds the best JPEG quality under the budget.
5. `zones` on each, then `phone <sheet.png> <a> <b> <c>` with a new file name each time. Look at the sheet. At 168 px wide you should be able to read each word and name each subject. If you cannot, it fails: make the words bigger or fewer.

# Provenance — ElevenLabs voice

## Two licences, kept apart

- **The pack's code and docs** (`src/`, `test/`, `README.md`) are MIT, see the repository `LICENSE`.
- **The ElevenLabs mark in `assets/icon.svg`** is a **trademark of ElevenLabs**. The MIT licence does not cover it, and
  this pack implies no affiliation with or endorsement by ElevenLabs.
- **The glyph path data** is taken verbatim from [Simple Icons](https://github.com/simple-icons/simple-icons),
  released under **CC0-1.0**. CC0 covers the path data's copyright only and grants no trademark rights; using the
  mark is subject to ElevenLabs' brand guidelines.

## Source

| | |
|---|---|
| Path data | [`icons/elevenlabs.svg`](https://raw.githubusercontent.com/simple-icons/simple-icons/ac1bf3df4e3d4cd1ce03cedb96d6165d2e98fe99/icons/elevenlabs.svg) at Simple Icons 16.34.0, commit `ac1bf3df4e3d4cd1ce03cedb96d6165d2e98fe99` (`master`, 2026-10-04) |
| Brand hex | `#000000` (`data/simple-icons.json` at the same commit) |
| Official brand guidelines | https://elevenlabs.io/brand |

The path is the "11" symbol: two vertical bars, each 4.9317 wide, with a gap equal to one bar, on a 24 unit square.
It is the same shape as `elevenlabs-symbol.svg` from the guidelines page (bars 60 by 292 with a 60 gap on a 876
canvas): identical proportions, one is only scaled to the other.

## How it is presented

The guidelines show the symbol black on a white holder (circle, rounded square or square), with the holder three times
the height of the symbol. `assets/icon.svg` is that: a white rounded square 72 units across, the path untouched at 24
units tall and centred, filled `#000`. Only the holder is the pack's own, a hairline edge so the white holder keeps its
shape on a light card.

The holder is part of the file because Dimension draws a pack's icon as an image, where `currentColor` is always black
and a card's theme cannot reach in: a bare black mark disappears on a dark card.

If ElevenLabs asks for the mark to be removed or changed, replace `assets/icon.svg`.

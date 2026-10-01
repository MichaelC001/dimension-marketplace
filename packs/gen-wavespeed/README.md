# WaveSpeed generators

## What it is

One WaveSpeed AI key that lets the agent turn pictures into 3D models, with ten generators from Tripo,
Meshy, Hyper3D, TRELLIS.2 and Tencent Hunyuan behind it. It is a connector for the engine's `generation`
jobs; it adds no tool of its own. The engine runs each job, prices it first and keeps the spend caps;
this pack only talks to WaveSpeed.

## What it contains

- **A `generation` provider, id `wavespeed`.** It produces `model3d` only and runs against WaveSpeed's
  API (`runtime: "api"`). WaveSpeed's catalogue lists no rigging, retopology or part-splitting model, so
  this pack offers none.
- **Ten models**, listed in `models.json`:
  - Tripo P2 image to 3D (`tripo3d/p2/image-to-3d`);
  - Tripo H3.1 image to 3D (`tripo3d/h3.1/image-to-3d`) and multiview to 3D (`tripo3d/h3.1/multiview-to-3d`, 2 to 4 images);
  - Meshy 6 image to 3D (`meshy/v6/image-to-3d`);
  - Meshy 7.1 image to 3D (`meshy/v7.1/image-to-3d`) and multi-image to 3D (`meshy/v7.1/multi-image-to-3d`, up to 4 images);
  - Rodin 2.5 (`hyper3d/rodin-v2.5/image-to-3d`, up to 5 images);
  - TRELLIS.2 (`wavespeed-ai/trellis-2/image-to-3d`);
  - Hunyuan3D 3 (`wavespeed-ai/hunyuan3d-v3/image-to-3d`, with optional back, left and right views) and
    Hunyuan3D 3.1 Rapid (`wavespeed-ai/hunyuan-3d-v3.1/image-to-3d-rapid`).
- **Live options and prices.** A model is offered only while WaveSpeed's catalogue lists it and its
  request still has the fields the pack maps. The option schema comes from WaveSpeed, and every price
  comes from WaveSpeed's pricing API for the exact request, not from `models.json`. `models.json` holds
  what WaveSpeed does not publish: the input mapping, a sentence on how each price is made up, the
  licence and the feature tags.

No tools, skills, rules or components.

## Who can use it

Off by default (`defaultEnabled: false`); switch it on, then open its Connect form and paste a
WaveSpeed API key. It is global: it declares no `spaces`, so once on it loads in every space. Connecting
spends nothing. The key is kept on this machine at `~/.config/dimension-gen-wavespeed/key.json` and
sent only to `api.wavespeed.ai`. A new WaveSpeed account is limited to 5 predictions a minute and 2
running tasks at once; a first top-up raises that to 500 a minute and 300 tasks.

## Limits and risks

- **Every job spends real money.** WaveSpeed is prepaid and each task is charged to your balance. The
  price is read before submit and the engine refuses a job over `generation.maxUsdPerJob`, or one that
  would take the UTC day past `generation.maxUsdPerDay`. At the prices `models.json` records for
  2026-10-02, a job runs from $0.10 (TRELLIS.2 at 512) to about $2.30 (Meshy 7.1 with 4K geometry,
  auto-rigging and an animation preset).
  WaveSpeed refunds failed and timed-out tasks automatically.
- **A running job cannot be cancelled.** WaveSpeed has no endpoint that stops a task, so this provider has
  no `cancel`: a job you stop in Dimension still finishes and is billed as quoted, and the engine says so
  rather than booking it as cancelled at $0.
- **No licence is cleared.** WaveSpeed publishes no per-model licence and leaves each third-party model's
  terms to you, so every model's output is recorded with commercial use `unknown`, which blocks a
  release export until the upstream terms are reviewed. Hunyuan3D 3 and 3.1 Rapid are also marked
  `prototypeOnly`, on the nearest published terms, Tencent's Hunyuan 3D 2.1 community licence, which
  excludes the EU, UK and South Korea.
- **Uploads leave this machine.** Reference images are uploaded to WaveSpeed's storage under a
  generated file name and kept there for 7 days. The pack reuses an upload for half of that time.
- **Prices depend on options.** Textures, detailed geometry, quad topology, rigging, animation presets and
  extra views change the quote on some models; the model's `basis` in `models.json` says how, and the
  quote is what counts.

## Build and test

There is no build step: the engine loads `index.ts` as it is. The tests run on an in-memory WaveSpeed
built from WaveSpeed's real responses (`test/fixtures/`, provenance in `test/fixtures/sources.json`),
with no network and no key. From the Dimension repository root:

```sh
bun test marketplace/packs/gen-wavespeed/test
```

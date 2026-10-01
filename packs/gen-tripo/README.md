# Tripo 3D generation

## What it is

Tripo's own pay-per-use API for the agent: turn one picture, or several views of the same thing, into a
3D model, then keep working on that model: split it into parts, re-mesh it, rig it, put animation clips
on the rig, convert it for a game engine. It is a connector for the engine's `generation` jobs; it adds
no tool of its own. Each step is a Tripo task, and a later step names the earlier one by its Tripo task
id, so the rig lands on the exact mesh that was generated with no download and upload in between.

## What it contains

- **A `generation` provider, id `tripo`.** It produces `model3d`, `parts`, `rig` and `retopo`, and runs
  against Tripo's V3 API at `openapi.tripo3d.ai/v3` (`runtime: "api"`).
- **Seventeen models**, listed in `models.json` with their options, prices and constraints:
  - image to 3D and multiview to 3D (2 to 4 images), each in three generations: H3.1, P2 (preview) and P1;
  - mesh segmentation `segmentation/v1.0` and `segmentation/v2.0` (beta), and part completion `completion/v1.0`;
  - smart retopology `lowpoly/v2.0` and basic decimation `lowpoly/v1.0`;
  - auto-rig `rig/v2.5` (biped, quadruped, hexapod, octopod, avian, serpentine, aquatic) and `rig/v1.0` (biped only);
  - animation `retarget`, which bakes preset clips onto a rig;
  - format `convert` (GLTF, FBX, USDZ, OBJ, STL, 3MF);
  - re-texturing `texture/v3.5` and `texture/v3.0`.
- **Chaining.** A result carries Tripo's task id as its handle. A later request sets `input.from.handle`
  to continue from it; some models take a local mesh in `input.model` instead.

Nothing vendor-specific is hard-coded in `index.ts`: model ids, parameters, prices, upload limits and
licences are all in `models.json`, next to the Tripo pages they were read from.

## Who can use it

Off by default (`defaultEnabled: false`); switch it on, then open its Connect form. It is global: it
declares no `spaces`, so once on it loads in every space. The form asks for two things:

- a **Tripo API key** (starts with `tsk_`), made on the Tripo platform after you buy API credits;
- **Paid for Tripo credits? (yes / no)**. Answer `no` while you are on the free trial.

Connecting spends nothing. The settings are kept on this machine at
`~/.config/dimension-gen-tripo/key.json`, and the key is sent only to `openapi.tripo3d.ai`.

## Limits and risks

- **Every job spends real money.** One credit is $0.01. The price is quoted before submit and the engine
  refuses a job over `generation.maxUsdPerJob`, or one that would take the UTC day past
  `generation.maxUsdPerDay`. An H3.1 image to 3D starts at $0.20 untextured; P2 starts at $1.00, and
  $1.30 with an 8K texture. Tripo freezes the credits when a task is created and releases them if it
  fails, so a failed task is booked as billed only when Tripo reports credits consumed.
- **A task is never resent after a failure that might have reached Tripo**, because each submit is billed.
  Only a 429 or 503, where Tripo declined the request unprocessed, is retried.
- **Trial credits give you no commercial rights.** Output made on free or trial credits belongs to Tripo
  (Terms 5.2.1), and Tripo cannot tell trial credits from bought ones, so Dimension relies on your
  answer. Anything but `yes`, including an older connection that never answered, stamps the output
  `tripo-api-trial`: non-commercial and prototype-only. Credits you bought give `tripo-api-paid`: you
  own the output, but you may not build a competing model from it or expose Tripo's 3D service to third
  parties (Terms 3.2). The licence is fixed when the job is submitted.
- **Uploads leave this machine.** The images and meshes you generate from are uploaded to Tripo
  (images up to 20 MB as `png` or `jpg`; meshes up to 150 MB as `glb`, `gltf`, `fbx`, `obj` or `stl`).
- **Parts and textures do not go together.** `generate_parts` needs `texture: false` and `pbr: false`,
  and neither `quad` nor `smart_low_poly`; the pack refuses the request rather than let Tripo reject it
  or drop the parts.
- **Other combinations the pack refuses**: `texture_quality: "fast"` without `texture_version`
  `v3.5-20260815`; `force_symmetry` without `quad`; vertex colours in anything but OBJ or GLTF;
  `retarget` with both `animation` and `animations`, or neither.
- **Some prices are inferred.** Where Tripo's pages disagree or are silent, `models.json` says so in the
  model's `priceBasis` (the rig price, the P2 quad surcharge, segmentation with a reference image); the
  task's own reported credits are what counts.
- **The V3 API only.** The V2 API stops serving on 2026-11-01 and this pack does not use it.

## Build and test

There is no build step: the engine loads `index.ts` as it is. The tests run on an in-memory Tripo built
from Tripo's documented responses (`test/fixtures/`), with no network and no key. From the Dimension
repository root:

```sh
bun test marketplace/packs/gen-tripo/test
```

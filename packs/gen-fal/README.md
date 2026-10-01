# fal.ai generators

## What it is

One fal.ai key that lets the agent make 3D models: from a picture to a model, a model split into parts,
a model re-meshed to clean topology. It is a connector for the engine's `generation` jobs; it adds no
tool of its own. The engine runs each job, prices it first and keeps the spend caps; this pack only
talks to fal.

## What it contains

- **A `generation` provider, id `fal`.** It produces `model3d`, `parts` and `retopo`, and runs against
  fal's API (`runtime: "api"`).
- **Eight fal endpoints**, listed in `models.json`:
  - image to 3D: Pixal3D (`fal-ai/pixal3d`), TRELLIS.2 (`fal-ai/trellis-2`), Rodin 2.5
    (`fal-ai/hyper3d/rodin/v2.5`), Meshy-6 (`fal-ai/meshy/v6/image-to-3d`), Hunyuan 3D 3.1 Pro
    (`fal-ai/hunyuan-3d/v3.1/pro/image-to-3d`) and Tripo P2 (`tripo3d/p2/image-to-3d`);
  - Hunyuan 3D 3.1 Part splitter (`fal-ai/hunyuan-3d/v3.1/part`), which splits an `fbx` into parts;
  - Hunyuan 3D 3.1 Smart Topology (`fal-ai/hunyuan-3d/v3.1/smart-topology`), which re-meshes a `glb` or `obj`.
- **Live options and prices.** An endpoint is offered only while fal's catalogue lists it as active and
  its input still has the fields the pack maps. The option schema and the unit price are read from fal
  (cached for 10 minutes), not from `models.json`, so a repricing or a new option needs no release.
  `models.json` holds what fal does not publish: the input mapping, the billing units per request, the
  licence and the feature tags.

No tools, skills, rules or components.

## Who can use it

Off by default (`defaultEnabled: false`); switch it on, then open its Connect form and paste a fal API
key. It is global: it declares no `spaces`, so once on it loads in every space. Connecting spends
nothing. An API-scope key covers generation, the catalogue and prices. The real cost of a job is read
from fal's billing events, which need an admin-scope key; without one the job is recorded at its quote.
The key is kept on this machine at `~/.config/dimension-gen-fal/key.json` and sent only to fal
(`queue.fal.run`, `api.fal.ai`, `rest.fal.ai`).

## Limits and risks

- **Every job spends real money.** fal is prepaid and each job draws down credits. The price is quoted
  before submit and the engine refuses a job over `generation.maxUsdPerJob`, or one that would take the
  UTC day past `generation.maxUsdPerDay`. At the prices `models.json` records for 2026-10-01, a job costs
  from about $0.25 (TRELLIS.2 at 512p) to $1.30 (Tripo P2 at its top texture quality); Meshy-6 is a flat
  $0.80. fal's live price is what is quoted.
- **Licences differ per model, and some are prototype-only.** Pixal3D (the weights' commercial terms
  are disputed upstream, and its encoder is Meta's DINOv3) and all three Hunyuan endpoints (Tencent's
  community licence excludes the EU, UK and South Korea) carry `prototypeOnly` and are not cleared for
  a release. TRELLIS.2 is MIT but depends on DINOv3 and on a background remover whose licence is
  unreviewed. Rodin, Meshy and Tripo outputs follow fal's terms (the customer's output, no
  commercial-use restriction); those vendors' own terms were not reviewed. The licence is stamped on
  the job when it is submitted.
- **Uploads leave this machine.** Reference images and 3D files are sent to fal's CDN, served by public
  URL, and asked to expire after 24 hours. Rodin, Meshy, Hunyuan and Tripo are partner models: fal
  passes your prompt, options and files on to those vendors.
- **The part splitter and Smart Topology take a file, not a prompt**: an `fbx` for the splitter (30k
  faces, 100 MB at most), a `glb` or `obj` for Smart Topology (200 MB at most).
- **Cancel is a request to fal.** A job fal says had already completed, or no longer knows, is not
  treated as stopped, because it may have been billed; the engine keeps polling it.

## Build and test

There is no build step: the engine loads `index.ts` as it is. The tests run on an in-memory fal built
from fal's real responses (`test/fixtures/`), with no network and no key. From the Dimension repository
root:

```sh
bun test marketplace/packs/gen-fal/test
```

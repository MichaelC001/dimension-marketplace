# Image

Generate and edit images in any Dimension session, whatever the harness.

- **The image role picks the model.** Settings → Models → Image generation orders the models with fallbacks. By
  default: GPT Image 2.5 Sunburst (OpenAI key or OpenRouter), the ChatGPT subscription, Nano Banana Pro (Google or
  OpenRouter), GPT Image 2, Nano Banana 2, Grok Imagine, Seedream 5.0 Pro, FLUX.2 Pro. Only models you have a login
  for are tried; a failure falls through to the next.
- **Or name one.** "Use Nano Banana for this" — any image model by name, id or `provider/model`.
- **No new keys.** It runs on the logins Dimension already has (OpenAI, the ChatGPT subscription, Google, OpenRouter,
  xAI). Image-only vendors plug in as generation provider packs.
- **Edits, masks and transparency.** Reference and edit images, masked repaints, transparent backgrounds, and local
  cut-outs, crops, resizes and format changes that cost nothing.

Tools (engine-hosted, so every harness gets them): `image_generate`, `image_models`, `image_process`, `image_mask`.
Pictures are saved under Dimension's images folder, one subfolder per session, unless a call names `outDir`.
Design: `docs/design/101-image-generation.md` in the Dimension repo.

Where your prompt goes: to the provider of the model that runs it, with any picture you attach.

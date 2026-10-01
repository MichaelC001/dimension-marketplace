# Face to face

Talk to your agent and watch it answer. A full-screen surface for the Chat space: a halftone dot-matrix head
that turns, blinks and lip-syncs to the **actual spoken audio**, captions every word as it is said, and a small
living orb that opens it.

One bundle, two components (`plugin.json`):

| id | export | fills |
|---|---|---|
| `face-to-face` | default (`FaceSurface`) | the space's `face` workspace surface (`components.face`) |
| `face-to-face-door` | `FaceDoor` | the pinned widget `widgets.pinned: [{ fill: "face-to-face-door", post: "bottom-right" }]` |

A space opts in with `workspace.surfaces: [..., "face"]`, `workspace.chrome.face: "none"`,
`components.face: "face-to-face"`, the pinned door, a rail action `{ target: "surface", surface: "face" }`,
and `requires.plugins: ["face-to-face"]` (the Chat space's `packs/chat/plugin.json` is the wiring proof).

## How it talks

The pack has **no transport of its own**. All voice comes from the kit hook `useVoiceConversation()` (granted in
`fraym/packages/ui/src/shell/space/host-externals.ts`); `src/surface/voice.ts` is the only file that touches it.

| hook | on screen |
|---|---|
| `phase` | face state (`listening` / `thinking` / `speaking`), the label beside the waveform, which controls exist |
| `levels.getAgent()` / `getMic()` | the waveform mark, the jaw coupling in the procedural mouth |
| `words` + `audioClock()` | the two-line captions and the procedural lip timing |
| `faceAt()` (52 ARKit weights, `ARKIT_52_NAMES` order) | the mouth, when non-null; otherwise the procedural mouth, cross-faded |
| `partial` | the person's live words, in the captions' place |
| `notice` / `error` | shown verbatim (a key to connect, a model downloading), with a hint only when the words name the cause |
| `micLive` | the red dot and **Mic on**, always visible |

**Consent.** The microphone opens from one place: the click on **Tap to talk** (or **Try again** after a
failure). Mounting the surface, in any state, never starts a conversation. Back to thread and Esc call `stop()`
(which releases the mic) and mount the `session` surface. If the host order of `ARKIT_52_NAMES` ever differs from
this pack's rig, the model is ignored and the procedural mouth is used.

**A fresh start.** With no session yet (the Chat space's first contact, before anything was sent) the surface still reads as
ready: readiness is the engine's and the window's. **Tap to talk** there opens the microphone in the click, asks the host
for the pane's session (the hook's `act("ensureSession")`, which carries no message) and talks on it as soon as the seat
reports it, so pressing it once creates one session and starts the conversation.

**With voice mode.** Voice mode (doc 91 of the Dimension repository) is the reply hook that speaks any session's
replies from the composer's speaker toggle; the Face is its cascaded-loop front. While a conversation is open for a
session the voice desk is silent for THAT session, because the conversation's own voice carries its audio and its face frames;
every other session keeps the desk's behaviour. The kit's `useVoiceConversation` tells the desk when it starts and stops, so
this pack does nothing for it.

## The head asset (an SDK gap, solved by inlining)

A pack bundle is fetched, hash-checked and `import()`ed from a **Blob URL**, so it has no file path of its own; the
fill props carry no asset base (`resolvePluginAssetUrl` is a host-frame prop, never passed to a fill); and the
engine's `/plugin-assets` route serves only allow-listed extensions, `.bin` not among them. The baked head
(`assets/head-f01.bin`, ~130 KB, already deflate-raw inside) therefore ships **inside the bundle** as a base64
data URL (`vite build` with `assetsInclude: ["**/*.bin"]` and `import ... ?inline` in `src/surface/head-source.ts`),
~175 KB of `dist/index.mjs`. **Re-bake the head, then `bun run build`**; `test/externals-grant.test.ts` fails when
the committed bundle carries a different head than `assets/`.

## Build, test

```
bun run build      # vite build -> dist/index.mjs (committed: the host loads the built bundle)
bun test           # this pack's tests
bun run typecheck  # tsc (the kit's own sources add one unrelated error in presence/wisp-geometry.ts)
```

The bundle's runtime imports are exactly `react`, `react/jsx-runtime` and the granted `@fraym/ui` name
`useVoiceConversation`; a bundle importing an ungranted name is refused whole, which `test/externals-grant.test.ts`
checks against the built file and the sources.

## Layout

- `src/index.tsx` — the two components; the only wiring to the host.
- `src/surface/` — the surface: `surface-model.ts` (pure: phase to screen, Back/Esc), `face-surface.tsx`, `face-door.tsx`,
  `orb.ts` (the door's dots), `waveform*.ts(x)`, `voice.ts` (hook adapter), `head*.ts` (asset), `styles.ts`.
- `src/face/` — the face itself: animator, lip-sync, expressions, WebGL2 dot renderer, captions (see `PROVENANCE.md`
  for the head's licence).

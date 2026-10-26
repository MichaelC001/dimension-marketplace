# Chat

## What it is

Your personal assistant in a room of its own. A calm conversation with Aether, a rail of your past sessions beside it, and a viewer that opens the documents, slides and images it makes. No repo, no branches, no developer chrome: one layout and one space, assembled entirely from marketplace packs. Open **Face to face** to talk with it out loud.

## What it contains

Metadata only: a layout (`chat`, slots `switcher`, `rail`, `workspace`, `artifact-view`) and one space (`chat`). The space declares which pack fills each slot and requires them:

| slot or part | pack |
|---|---|
| switcher | `classic-switcher` |
| rail | `chat-rail` |
| workspace | `classic-workspace`, with the sections `chat-thread` (thread), `independent-composer` (composer) and `classic-start` (start) |
| also required | `swiss-knife` |
| `face` surface and its door | `face-to-face` |

It talks to the General Agent `aether` in the `inso-personal` workspace. It has no tools, skills, prompts or rules of its own.

`assets/preview/` is the space's listing: two screenshots and a 13-second clip of a real Live call (Face, **Talk live**, a spoken question, the voice answering), recorded on a dev lane of this checkout with a real ElevenLabs agent.

## Who can use it

Anyone, on every release ring: none of the eight packs it requires, and not this one, carries a `channel`. It is on by default. The Face needs Dimension 0.11.16 or newer (`face-to-face` `requires.dimension`); on an older build the engine skips that pack and the Face's place reads "This space surface is not installed", with text that says to reinstall, which does not help: the fix is updating Dimension. To talk, a voice profile must name a ready speech provider; **Talk live** needs a Live-capable provider (an ElevenLabs key with the Agents permissions, or Codex realtime) and a session in the pane, which a brand-new Chat does not have yet: send a first message, or press **Tap to talk** once.

## Limits and risks

- The space requires all eight packs it names. A pack that needs a newer Dimension than the build is skipped by the engine and the space still opens without what it filled: on a 0.11.15 build the Face's place reads "This space surface is not installed ... Reinstall or enable the space plugin, then try again." Reinstalling cannot fix it; updating Dimension does.
- Talking opens the microphone and sends audio to the voice profile's provider; see the Face's README for exactly what is sent and where.
- The space stores nothing itself: sessions live where every other space keeps them, scoped to the `inso-personal` workspace. The one exception is `chat-rail`, which keeps Collections in the webview's `localStorage` (see its README).

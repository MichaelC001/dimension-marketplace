# Disclosure, licence and credits

YouTube asks one question at upload, **AI use** under Attributes (YouTube, answer 14328491; older material calls it "altered content"). A person may answer for their own film. Your job is to put the facts in front of them and record the answer with its reasons, so the answer is not a guess made at the upload form.

## What YouTube says must be disclosed

Disclose AI-generated or meaningfully AI-altered content that **seems realistic** (YouTube, answer 14328491). The page lists four kinds:

1. It makes a real person appear to say or do something they did not.
2. It alters footage of a real event or place.
3. It generates a realistic scene that did not happen.
4. It creates music that is the main focus of the video.

Its examples that need the label include AI-generated music, AI-extended footage of a real place, a realistic scene of a weather event moving on a real city, and a public figure shown doing or saying something they did not.

## What does not need it

Non-realistic content made with AI, and minor edits (YouTube, same page): an animation in a fully animated video, green screen, colour and light filters, upscaling and repair, captions, and **production assistance such as AI help with an outline, script, thumbnail or title**. It also lists **cloning one's own voice for voice-overs or dubs**.

Disclosing does not limit the audience or take away eligibility to earn (same page). Not disclosing when it was required can end in a label added by YouTube, removal, or suspension from the Partner Program.

YouTube may add a label itself for content made with its own tools, content carrying C2PA metadata, and content its systems detect as AI. Such a label cannot always be removed afterwards. Some image and video generators write C2PA metadata; check what the generator did before telling the person the film needs no label.

## How to assess a film

List the records in `media/*.asset.json`. Every one whose `license` is `generated`, `commentary` or `unknown` gets a row in `settings.alteredContent.assets`: `id`, `verdict` (`disclose` or `no-disclosure`), `category`, and a `reason` in one sentence that names what the viewer sees or hears. Assets whose licence is `owned` or `cc0` need no row.

| Asset | Usual verdict | Category | Check |
|---|---|---|---|
| A generated voice-over in the person's own cloned voice | `no-disclosure` | `own-voice-clone` | Ask: "Is this voice yours?" Set `confirmedByPerson: true` only on their yes. A voice that is not theirs is `voice-of-someone-else`, which discloses |
| Generated music | `disclose` | `ai-music` | YouTube's headline rule is music that is the main focus; its examples list any AI-generated music. When the music is a quiet bed under speech, say that in the reason and let the person decide; the default is to disclose |
| Generated b-roll that is clearly stylised, animated or abstract | `no-disclosure` | `not-realistic` | Look at the frames. If anyone could take it for real footage, it is not this |
| Generated b-roll that looks like real footage of a real place or event | `disclose` | `realistic-scene-did-not-occur` or `altered-real-footage` | |
| A generated image of a real person, or footage made to look like they said or did something | `disclose` | `real-person-says-or-does` | Also a likeness and defamation question: ask the person before it ships |
| A third-party clip used for commentary (licence `commentary`) | `no-disclosure` | `unaltered-real` | Only while the clip is unaltered and shown as a clip. If it was re-voiced or edited to change what it shows, it is `altered-real-footage` |
| Motion graphics made in the film (licence `owned`) | no row | | |
| AI help with the script, the title, the thumbnail | no row | `production-assistance` if you want to record it | |

`settings.alteredContent.disclose` is `true` when any row discloses and `false` when none does: the gate refuses a package that says otherwise. When it is `true`, add the plain line about AI to the description.

Say the result to the person in two sentences before the upload: what will be labelled and why, and which clips you judged not to need it. They decide, and you record their decision, not yours.

## Licence class `commentary`

A short third-party clip used for commentary or parody. The asset record carries `sourceUrl`, `attribution` (the credit line), `durationSeconds` (at most 15), and `commercialUse` stated. The editor's own gate reports each one as a warning, `commentary-clip`. For the package:

- Put the credit line and the source URL in the description, word for word. The gate refuses a package without them.
- Keep the clip short and the commentary the point of using it. Fair use is not something you can promise; say plainly to the person that the call is theirs and that a rights holder can still claim the clip.
- A film with commentary clips is not `cc-by`.

## Channel licence

`settings.license` is `standard` unless the person says otherwise. **CC BY** may only be set on a film made entirely of content the person can license: their own, CC BY material, or public domain (YouTube, answer 2797468). The gate refuses `cc-by` when any asset is not `owned` or `cc0`. Credits for CC BY material are required in the description.

## Made for kids, age restriction, paid promotion

`madeForKids` is `false` and the gate refuses anything else: a made-for-kids film is a different job that needs the person's decision about the audience. `ageRestricted` is a plain true or false. `paidPromotion` is true only when the person says a sponsor or paid product placement is in the film; never guess it.

## End screen

An end screen needs a video at least 25 s long and cannot be set on a made-for-kids film. `endScreen.enabled: true` records the plan (the last 5 to 20 seconds of the film are for it); Studio's editor is where it is set.

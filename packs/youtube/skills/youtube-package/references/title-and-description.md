# Titles, description, tags, chapters

What YouTube says in writing is marked **(YouTube)** with its help page. What other people measured is marked **(measured)**: use it to break a tie, not to overrule the film.

## Limits the gate enforces

| Field | Limit | Where it comes from |
|---|---|---|
| Title | 100 characters, no `<` or `>` | Data API and Studio |
| Description | 5,000 bytes, no `<` or `>` | Data API. Studio's help page says 5,000 characters; the gate counts bytes, which is the stricter of the two |
| Tags | 500 characters in all; a comma between tags counts, and a tag with a space counts its two quote marks | Data API |
| Chapters | 3 or more, the first at `00:00`, each at least 10 s, ascending | (YouTube) answer 9884579 |
| Hashtags | 3 show above the title; more than 60 and YouTube ignores all of them | (YouTube) |
| Thumbnail | 1280×720, 2 MB or less, png or jpg | Studio |

## Titles

1. **Accurate first.** A title that does not match the video makes people stop watching, which costs discoverability (YouTube, answer 12340300). Misleading titles and thumbnails meant to get views are "malicious clickbait" under the spam policy (YouTube, answer 2801973). The film's intro has to deliver what the title and thumbnail promised (YouTube, answer 16559650).
2. **Short, important words first.** Viewers may only see part of the title. Keep episode numbers and branding for the end. Limit ALL CAPS and emoji (YouTube, answer 12340300).
3. **Searchable or intriguing, not both at once.** A searchable title says plainly what to expect and reaches people searching for it. An intriguing title sparks curiosity in people who were not looking for the topic. Pick by who is meant to watch and where they will meet it (YouTube, answer 12340300).
4. **Length** (measured, 18,080 channels): 30 to 50 characters did best in every niche studied; 90 or more did worst. The gate's length score is 5 for 30 to 50, 4 for 20 to 29 and 51 to 60, 2 for under 20 and 61 to 70, 1 beyond that. It is computed from the text, so a recorded score cannot be wrong; the gate refuses one that is.
5. **Numbers** helped in Tech titles (measured, same study). A title with a number needs the film to deliver that number.
6. **Curiosity gaps** raised the spread of results and did not lift the average (measured, 3,357 videos), and openers like "this" or "these" did worst. The linter warns on a "this" or "these" opener.

### How to write them

Write at least five options across at least two patterns, so the choice is a comparison. Usual patterns: `how` (how X works), `contrast` (X, not Y), `number` (3 things that...), `claim` (the sentence the film proves), `question`, `name` (the product or the thing named, then what it does). Score each option on six lines, whole numbers 0 to 5:

| Line | 5 means | 0 means |
|---|---|---|
| accuracy | every word is something the film shows or proves | the film does not deliver it |
| clarity | a stranger knows the topic before the click | cannot tell what it is about |
| curiosity | a reason to click that the film pays off | nothing to wonder about |
| search | the main phrase is in it and sounds like a search | nobody would type it |
| length | computed by the gate from the character count | over 100 characters |
| risk | nothing in it could be read as a promise the film breaks, a claim about a person, or a trademark misuse | would draw a strike or a correction |

Ship an option at **22 of 30 or more with accuracy and risk both 4 or more**. If none reaches it, write better options; do not pass a lower one. Put the winner in `title.chosen`, word for word the same as its option.

`node "<SKILL_DIR>/scripts/publish-check.mjs" title --file <file holding the title>` prints the length, the length score and every lint warning for one title. Run it on each option before scoring. A title is model-written text: pass it in a file, never inside a quoted shell argument, where `$(...)`, backticks and `"` still act.

### Proof for the title

The claim ledger (`receipts/claims.json`) lists every claim the film makes and the proof for it. The title may only state a claim that is in the ledger with proof. If the title says "in 3 minutes" the film must run about that; if it says "the only", you need the source for "only".

## Description

The first lines are all a viewer sees before "more" on a phone, and they tell the recommender what the video is about (YouTube, answer 12948449). So:

1. **Open with one or two sentences that say what the film shows and what the viewer gets**, with the main phrase in the first 150 characters. The gate warns if `description.primaryKeyword` is not there. No link, no hashtag, no timestamp list and no "In this video" in those lines.
2. **Pick one or two main words** and use them in the title and the description (YouTube, answer 12948449). Each video needs its own description; never paste one across films.
3. **Chapters as one unbroken block** after the hook. Build them from the edit's markers, never by hand:
   `node "<SKILL_DIR>/scripts/publish-check.mjs" chapters "<production-dir>" --intro-title-file <file holding the name of the opening>`
   It reads `edl.json`, adds a `00:00` chapter when the first marker is later, uses hours only from one hour up, and reports what it did. If a marker is too close to the next one it names it; fix the marker in the edit (or pass `--merge-short` to fold short ones into the chapter before). A film under 30 s has no chapters and its description carries no timestamp lines. Chapter titles are the marker labels: rename a marker in the edit, not here.
4. **Sources.** Each claim in the film that rests on a page gets its link, labelled. Copy them from the ledger's `sourceUrl` rows; do not add one the film does not use. `description.sources[].url` must appear in `description.text`.
5. **Credits.** Every asset that needs a credit has its credit line in the description, word for word (see [disclosure-and-credits.md](disclosure-and-credits.md)).
6. **One plain line about AI** when anything was made with it and the film carries the label: what was made by AI and what was not. This is the viewer-facing part of the disclosure.
7. **Hashtags last**, three at most. They show above the title.
8. Never include `<` or `>`; the API refuses them.

## Tags

YouTube says tags play a minimal role, mainly for common misspellings (answer 146402). Ship `[]` or a few real phrases and misspellings of the product's name. Never pad. The gate counts the 500 character budget and refuses duplicates.

## Captions

Upload the film's own SRT (the one `export_edl` wrote under `renders/`), not an auto track. Read it against the script and the claim ledger before you set `captions.reviewed: true`: product names, numbers and quotes are where captions go wrong. The gate refuses an SRT that has overlapping or backwards cues, a byte-order mark, or cues that run past the end of the master. A film with no speech sets `captions: { "file": null, "reason": "..." }`.

## Language

Set `settings.language` to the spoken language; captions file under the same language (YouTube, answer 6304325).

## Shorts

A Short is up to 3 minutes and square or vertical (YouTube, answer 12779649). Plan them while packaging: each `shorts[]` row names a part of the master (`fromSeconds`, `toSeconds`), its own title and hook. The gate refuses a row over 180 s or past the end of the master. Cutting and uploading them is a separate job through the edit: this package only records the plan.

## A/B test (optional, the person's call)

Studio can test up to 3 titles, up to 3 thumbnails, or both together; the option with the highest watch time is then shown to everyone, and if there is no clear winner the first one uploaded stays (YouTube, answer 16391400). It runs in desktop Studio only, needs advanced features turned on, and does not run on Shorts, private videos, made-for-kids videos or Premieres. Changing the title or thumbnail while it runs stops it, and a test takes a few days to two weeks. YouTube also advises testing options that really differ, since near-identical ones run long and end with no winner.

So the package records a plan, not a promise: `thumbnail.abTest` with `run`, `target` and the order to upload (the one that should win by default first). The person decides whether to run it; a first film on a new channel may not have the impressions to finish a test.

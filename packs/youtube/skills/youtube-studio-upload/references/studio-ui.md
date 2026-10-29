# Studio labels and where they came from

Two kinds of source. **YouTube help** is authoritative for what the screens contain and in what order. **Public automation projects** (the `sontm810` Studio upload skill, `linouk23/youtube-uploader`'s constants) are where the element ids come from; they were read in October 2026 and are hints, not a contract. Nothing here was exercised against a signed-in Studio.

## The flow (YouTube help, answer 57407)

| Page | Contents |
|---|---|
| Entry | Studio, **CREATE**, **Upload videos**, choose the file (up to 15 at a time) |
| Details | Title, Description, Thumbnail, Playlist, Audience, Age restriction; **SHOW MORE**: Branded content (paid promotion), **Altered content**, Automatic chapters, Tags, Language and caption certification, Recording date and location, License and distribution (embedding, notify subscribers), Shorts remixing, Category, Comments and ratings |
| Video elements | Subtitles and captions, End screen (film must be 25 s or longer), Cards |
| Checks | Copyright check; likeness detection runs too. A video can be published while checks run |
| Visibility | **Save or publish**: Private, Unlisted or Public; or **Schedule** (private until then) |

If the window closes before Visibility is chosen, the video is saved as private. A video can be published once SD processing is complete. A channel has a daily upload limit.

## Limits worth knowing (YouTube help)

Title 100 characters; description 5,000 characters and no invalid characters; thumbnail upload needs a verified account; custom thumbnails have a daily limit ("Daily custom thumbnail limit reached" means try again after 24 hours); A/B testing is desktop only, needs advanced features, and not for Shorts, private or made-for-kids videos.

## Hints for finding things

| What | By name (try first) | Id seen in public projects |
|---|---|---|
| Create menu | `aria/Create`, then `aria/Upload videos` | `ytcp-button#create-icon`, `tp-yt-paper-item#text-item-0` |
| File input of the upload dialog | inside `ytcp-uploads-file-picker` | `input[type=file]` |
| Title | the box labelled Title | `#title-textarea #textbox` (contenteditable) |
| Description | the box labelled Description | `#description-textarea #textbox` (contenteditable) |
| Thumbnail input | Upload file | `input#file-loader` |
| Not made for kids | `aria/No, it's not made for kids` | `tp-yt-paper-radio-button[name="VIDEO_MADE_FOR_KIDS_NOT_MFK"]` |
| More options | `aria/Show more` | `ytcp-button#toggle-button` |
| Altered content | text matching altered content or AI use (YouTube's two help pages use both names) | not recorded |
| Next, Done | `aria/Next`, `aria/Save`, `aria/Publish` | `#next-button`, `#done-button` |
| Visibility | `aria/Private`, `aria/Unlisted`, `aria/Public` | `tp-yt-paper-radio-button[name="PRIVATE"/"UNLISTED"/"PUBLIC"]` |

Studio is built from Polymer components in open shadow roots, so an ordinary CSS selector from the top does not reach inside; `pierce/` and `aria/` selectors do. Do not open `studio.youtube.com/upload`: go through Create, Upload videos (public projects report the direct URL being unreliable).

## When Studio changes

`await studio.ariaSnapshot()` is the ground truth of what is on screen. If a label here is gone, find its replacement in the snapshot, use that, and say in your answer which label changed so this page can be corrected.

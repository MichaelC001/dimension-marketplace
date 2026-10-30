# Studio labels and where they came from

Two kinds of source. **YouTube help** is authoritative for what the screens contain and in what order. **A signed-in run on 31 October 2026** (Chrome 156, a new channel without phone verification, a 237 s film uploaded Unlisted) is where the names and ids below were read; they are what Studio showed that day, not a contract. The ids first came from public automation projects (the `sontm810` Studio upload skill, `linouk23/youtube-uploader`'s constants); the run confirmed or replaced each one.

## The flow (YouTube help, answer 57407)

| Page | Contents |
|---|---|
| Entry | Studio, **CREATE**, **Upload videos**, choose the file (up to 15 at a time) |
| Details | Title, Description, Thumbnail, Playlist, Audience, Age restriction; **SHOW MORE**: Branded content (paid promotion), **Altered content** (shown as **AI use**), Automatic chapters, Tags, Language and caption certification, Recording date and location, License and distribution (embedding, notify subscribers), Shorts remixing, Category, Comments and ratings |
| Video elements | Subtitles and captions, End screen (film must be 25 s or longer), Cards |
| Checks | Copyright check; likeness detection runs too. A video can be published while checks run |
| Visibility | **Save or publish**: Private, Unlisted or Public; or **Schedule** (private until then) |

If the window closes before Visibility is chosen, the video is saved as private. A video can be published once SD processing is complete. A channel has a daily upload limit.

## Limits worth knowing (YouTube help)

Title 100 characters; description 5,000 characters and no invalid characters; thumbnail upload needs a verified account; custom thumbnails have a daily limit ("Daily custom thumbnail limit reached" means try again after 24 hours); A/B testing is desktop only, needs advanced features, and not for Shorts, private or made-for-kids videos.

## What was on screen

| What | By name | Element |
|---|---|---|
| Create menu | `aria/Create`, then `aria/Upload videos` | |
| File input of the upload dialog | | `input[type=file]` (`name="Filedata"`) inside `ytcp-uploads-file-picker`, in the light DOM |
| Title | the box labelled Title | `#textbox` (contenteditable) inside `#title-textarea` |
| Description | the box labelled Description | `#textbox` (contenteditable) inside `#description-textarea` |
| Thumbnail input | button `Upload file` | `input#file-loader` inside `ytcp-thumbnail-uploader`; without phone verification the button opens "Unlock more on YouTube: To add custom thumbnails, verify your phone number" |
| Not made for kids | `aria/No, it's not made for kids` | |
| More options | `aria/Show advanced settings` (its visible text is "Show more") | |
| Age restriction | collapsed until `aria/Age restriction` is pressed | radios `Yes, restrict my video to viewers over 18`, `No, don't restrict my video to viewers over 18 only` |
| Paid promotion | radios `Yes, my video includes paid promotion`, `No, my video doesn’t include paid promotion` (typographic `’`) | |
| Altered content | section titled **AI use**: radios `Yes, AI was used`, `No, AI wasn’t used` (typographic `’`) | |
| Tags | text box `Tags`, values separated by commas | each tag becomes a `ytcp-chip` |
| Language | button `Video language <value>` (`Select` when unset) | options are `tp-yt-paper-item` |
| License | button `License Standard YouTube License` | |
| Embedding, notify | checkboxes `Allow embedding`, `Publish to subscriptions feed and notify subscribers` (on by default) | |
| Category | a button named by its value (`People & Blogs` by default) | options are `tp-yt-paper-item` |
| Subtitles | the Subtitles row's `Add` on Video elements, then `Upload file`, then `With timing` and `Continue` (a system file picker) | the row then reads "English by you" |
| Next, Save | `aria/Next`, `aria/Save`, `aria/Publish` | |
| Visibility | `aria/Private`, `aria/Unlisted`, `aria/Public` | |
| Video link | text `https://youtu.be/<id>` beside the preview, and in the "Video published" dialog | other links on the page point at other videos |

On the edit page (`/video/<id>/edit`) visibility is text beside the button `Edit video visibility status`, and advanced settings and age restriction are collapsed again. The Subtitles page is `/video/<id>/translations`. Go through Create, Upload videos rather than opening `studio.youtube.com/upload` (public projects report the direct URL being unreliable).

## When Studio changes

`await studio.ariaSnapshot()` is the ground truth of what is on screen. If a label here is gone, find its replacement in the snapshot, use that, and say in your answer which label changed so this page can be corrected. The helpers in [studio-cells.md](studio-cells.md) find elements through shadow roots and the light DOM alike, so a build that moves components back into shadow roots needs no change there.

# Studio cells

Code for `browser_run`. Cell state persists, so open Studio and define the helpers once, then reuse them in later cells. Every helper returns what the page now shows, so a step is never "done" until it has been read back.

**What was exercised.** The helper mechanics below were run against a stand-in page built the way Studio is built (custom elements, nested open shadow roots, contenteditable text boxes, radio buttons with `aria-checked`, a file input inside a component, links in a shadow root): `pierce/` selectors find the elements, `tab.uploadFile` with an absolute path fires the page's change event with the right file name and size, select-all then `sendCharacter` replaces text including line breaks and reads back identical, and `aria/<name>` clicks reach buttons and radios inside shadow roots. **They have not been run against a signed-in Studio**: the labels and ids in [studio-ui.md](studio-ui.md) come from YouTube's help pages and public automation projects, and Studio changes its markup. When a step does not find its element, `await studio.ariaSnapshot()` and work from what is on screen.

## 1. Open Studio

```js
const PROFILE = "<the profile name or label the person gave, or browser_profiles showed>";
const studio = await browser.open({ name: "studio", url: "https://studio.youtube.com", profile: PROFILE, persist: true });
display({ where: await studio.url(), title: await studio.title() });
```

- A URL on `accounts.google.com` is the sign-in wall: stop, call `browser_view` so the person can sign in themselves, and carry on from the page they leave.
- A URL like `studio.youtube.com/channel/UC...` is a channel. If the person has more than one channel, the avatar menu has a "Switch account" entry: ask which one before going on, and record the channel in `upload.channelId`.

## 2. Helpers

```js
const readback = [];
const norm = text => String(text ?? "").replace(/\r/g, "").replace(/\u00a0/g, " ").trim();

// Record one field: what the package says and what the page shows. These rows become upload.readback.
const must = (field, expected, actual) => {
  const ok = norm(expected) === norm(actual);
  readback.push({ field, expected: norm(expected), actual: norm(actual), ok });
  return ok;
};

// Studio's title and description are contenteditable <div id="textbox"> inside a component whose id names it.
// Replace the text: click, select all, insert it in one go. Returns what the box now holds.
const setBox = (hostId, text) => studio.run(async ({ page }, { hostId, text }) => {
  const mod = process.platform === "darwin" ? "Meta" : "Control";
  let target;
  for (const handle of await page.$$("pierce/#textbox")) if ((await handle.evaluate(el => el.getRootNode().host?.id)) === hostId) target = handle;
  if (!target) throw new Error(`no #textbox inside #${hostId}`);
  await target.click();
  await page.keyboard.down(mod);
  await page.keyboard.press("KeyA");
  await page.keyboard.up(mod);
  await page.keyboard.sendCharacter(text);
  return target.evaluate(el => el.innerText);
}, { args: [{ hostId, text }] });

const readBox = hostId => studio.run(async ({ page }, { hostId }) => {
  for (const handle of await page.$$("pierce/#textbox")) if ((await handle.evaluate(el => el.getRootNode().host?.id)) === hostId) return handle.evaluate(el => el.innerText);
  throw new Error(`no #textbox inside #${hostId}`);
}, { args: [{ hostId }] });

// A file input that sits inside the named component (a page can hold several). The path must be absolute.
const attach = (hostName, path) => studio.run(async ({ page }, { hostName, path }) => {
  for (const handle of await page.$$("pierce/input[type=file]")) {
    if ((await handle.evaluate(el => el.getRootNode().host?.localName)) === hostName) { await handle.uploadFile(path); return true; }
  }
  throw new Error(`no file input inside <${hostName}>`);
}, { args: [{ hostName, path }] });

// Click by what a person would read: the accessible name. Reaches into shadow roots.
const press = name => studio.click(`aria/${name}`);

// Is the radio or checkbox with this name on? true, false, or null when the element carries no state.
const isOn = name => studio.run(async ({ page }, { name }) => {
  const [handle] = await page.$$(`aria/${name}`);
  if (!handle) throw new Error(`nothing named "${name}"`);
  return handle.evaluate(el => {
    const state = el.getAttribute("aria-checked") ?? (typeof el.checked === "boolean" ? String(el.checked) : null);
    return state === "true" ? true : state === "false" ? false : null;
  });
}, { args: [{ name }] });

// The 11 character id in the first youtu.be or watch link anywhere on the page, shadow roots included.
const videoIdOnPage = () => studio.run(async ({ page }) => page.evaluate(() => {
  const links = [];
  const walk = root => { for (const el of root.querySelectorAll("*")) { if (typeof el.href === "string") links.push(el.href); if (el.shadowRoot) walk(el.shadowRoot); } };
  walk(document);
  const hit = links.map(link => /youtu\.be\/([A-Za-z0-9_-]{11})|[?&]v=([A-Za-z0-9_-]{11})/.exec(link)).find(Boolean);
  return hit ? (hit[1] ?? hit[2]) : null;
}));
```

## 3. Create, Upload videos, attach the master

```js
await press("Create");
await press("Upload videos");
await studio.waitForSelector("pierce/ytcp-uploads-file-picker", { timeout: 30000 });
await attach("ytcp-uploads-file-picker", MASTER);          // MASTER: absolute path, forward slashes
await studio.waitForSelector("pierce/#title-textarea", { timeout: 120000 });
```

`MASTER` is `<production folder>/<master.path>` as an absolute path. A relative path is refused: `browser_run` has no working directory. If "Create" is ambiguous, `await studio.ariaSnapshot()` and click the one that is a button.

## 4. Title and description

```js
must("title", PUBLISH.title.chosen, await setBox("title-textarea", PUBLISH.title.chosen));
must("description", PUBLISH.description.text, await setBox("description-textarea", PUBLISH.description.text));
display(readback);
```

`PUBLISH` is the parsed `receipts/publish.json`: read the file in the agent and hand the strings to the cell as data (a `const PUBLISH = {...}` line at the top of the cell), never retype a description. If `description` does not read back identical, the line breaks were changed: insert it line by line, pressing Enter between lines, and read it again. Studio fills the title with the file name first; `setBox` replaces it.

## 5. Thumbnail

```js
await studio.uploadFile("pierce/input#file-loader", THUMB);   // absolute path of the chosen variant
```

Then `await studio.screenshot()` and look at the preview. Studio refuses a thumbnail on an account that is not verified and says so on the page; read the page for "verify" or "limit" before going on. A/B test: after the first thumbnail is in, press **A/B testing** and follow the page; if the control is not there, the channel does not have advanced features on: say so and keep the single thumbnail.

## 6. Audience, age, more options

```js
await press("No, it's not made for kids");
must("audience: not made for kids", "true", String(await isOn("No, it's not made for kids")));
await press("Show more");
```

Write each of these from `PUBLISH.settings` and read it back: made for kids (`false`), age restriction, paid promotion, **Altered content** (some pages call it **AI use**: match `/altered content|ai use/i` in `ariaSnapshot()`) answered from `settings.alteredContent.disclose`, tags, language, category, licence, embedding, notify subscribers. Read the question that is on the page and answer that question. For a drop-down (language, category): `press` the drop-down by its label, `press` the option by its visible text, then read its text back from `ariaSnapshot()`. Tags are one text box of comma-separated values and not a `#textbox`: `studio.click` it and `studio.type` the list.

## 7. Next, Next, Next

```js
await press("Next");   // Details to Video elements
await press("Next");   // Video elements to Checks
await press("Next");   // Checks to Visibility
```

Checks (copyright and likeness) run in the background and may report a claim: read what the page says and tell the person. YouTube lets a video publish while checks run, so a finished check is not what to wait for.

## 8. Visibility and the video id

```js
await press("Unlisted");            // Private, Unlisted or Public: from settings.visibility
const videoId = await videoIdOnPage();
display({ videoId });
```

Public goes through the person first (see the skill). Press the page's last button (**Save** for private and unlisted, **Publish** for public) only once `videoId` is not null. The upload and processing take as long as the file: wait in cells of at most 300 s (`studio.waitForSelector(..., { timeout })`), and `browser_run({ resume })` when a cell is still running.

## 9. Read it back

```js
await studio.goto(`https://studio.youtube.com/video/${videoId}/edit`);
display(await studio.ariaSnapshot());
```

Read title, description, thumbnail preview, audience, visibility and the altered-content answer, `must(...)` each against `PUBLISH`, and put `readback` into `upload.readback`. A row with `ok: false` stays in the file; the gate refuses a package whose readback has one.

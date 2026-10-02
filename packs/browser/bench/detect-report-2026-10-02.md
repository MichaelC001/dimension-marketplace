# Headless detection: what the pack's browsers show a bot check (2026-10-02, revision 2)

Measured, not argued. Every number below comes from a run on this machine (Windows 11, Ryzen 9 9950X3D, an NVIDIA GPU, Google Chrome 154.0.8037.x),
produced by `bench/detect-columns.mjs` (one column per process; commands below). `bench/sites/detect.mjs` is a local page with no network need: it
reads 49 signals a public bot check reads and says for each whether a detector would flag it. It is OUR page, written for this work, so it shows which
signals a change closes; it does not rank the browsers against a detector we did not write. It measures **property tells** and the two CDP side effects
below; it does not measure what commercial bot walls measure beyond that (see "Not measured").

Revision 2 corrects revision 1, which said "neither OMP nor this change addresses CDP Runtime.enable detection". OMP's `puppeteer-core` patch does
remove `Runtime.enable` (`omp/patches/puppeteer-core@25.3.0.patch:357-368`, `:562-595`, `:600-624`), and its `cdp-runtime-enabled` row here was inert (it read
`ok` for stock puppeteer, which sends it). The row is now a probe that is **true under stock puppeteer 25.11.0** (page and worker), proved by the saved-profile
test (`test/agent-browser.test.ts`), and this change removes `Runtime.enable` for throwaway agent browsers the way OMP's patch does.

## How each column was driven

```
bun bench/detect-columns.mjs --column stock       --runs 16            # puppeteer-core 25.11.0 launch({ headless: true }), nothing else
bun bench/detect-columns.mjs --column throwaway   --runs 16            # BrowserRuntime.open({}) from this checkout's src: AFTER
bun bench/detect-columns.mjs --column throwaway   --runs 16 --src <git archive of 188ca454 packs/browser/src, with recipes/>   # BEFORE
bun bench/detect-columns.mjs --column profile     --runs 16            # BrowserRuntime.open({ profile }): the View and every saved profile
bun bench/detect-columns.mjs --column omp --runs 16 --omp omp/packages/coding-agent/src/tools/browser/launch.ts --omp-puppeteer <OMP's patched puppeteer-core 25.3.0, bundled as ESM>
bun bench/detect-columns.mjs --column reader      --runs 6  (x4 processes; with and without --src)   # browser_read: each BrowserRuntime.read of a 1 KB page
```

Add `--no-gpu` for a host with no GPU (`--use-angle=swiftshader --enable-unsafe-swiftshader`, what a CI box or VPS has). Every run went through
`D:/tmp/release-0.11.1/tools/guarded.ts` (whole-tree memory cap 3072 MB, 120 s wall); the largest tree peaked at 1389 MB.

- **OMP browser (14 scripts)**: OMP's own `buildHeadlessLaunchArgs`, `stealthIgnoreDefaultArgs`, `applyStealthPatches` (the 14 scripts, the UA override on every
  page-type target) and `applyViewport`, as `tab-worker.ts` calls them, on OMP's own patched `puppeteer-core` 25.3.0 (the patched copy in the bun cache,
  bundled; its `FrameManager` sends no `Runtime.enable`, checked in the CDP log by the `cdp-runtime-enabled` row). OMP's `launchHeadlessBrowser` itself was not
  called: it launched the same Chrome and never connected under this harness (30 s timeout), so the `puppeteer.launch` call it makes is repeated with the
  options it passes. The same Chrome (`BROWSER_TEST_CHROME`) for every column.
- **pack throwaway AFTER / BEFORE**: BEFORE is `188ca454` (the base of this branch) `packs/browser/src`; AFTER is this change. The driver acts with
  `runtime.snapshot` (stock and OMP: a `querySelectorAll` evaluate).
- **pack View / saved profile**: unchanged path; BEFORE and AFTER identical.

## The signals, one by one

`FLAG` = the page saw a signal a bot check flags.

| signal | OMP browser (14 scripts, patched puppeteer) | stock puppeteer | pack throwaway BEFORE | pack throwaway AFTER | pack View / saved profile (unchanged path) |
|---|---|---|---|---|---|
| `webdriver` | ok | **FLAG** | **FLAG** | ok | **FLAG** |
| `navigator-own-properties` | ok | ok | ok | ok | ok |
| `ua-headless` | ok | **FLAG** | ok | ok | ok |
| `ua-data-headless` | ok | ok | ok | ok | ok |
| `platform-consistent` | ok | ok | ok | ok | ok |
| `chrome-object` | ok | ok | ok | ok | ok |
| `chrome-parts` | ok | ok | ok | ok | ok |
| `chrome-runtime` | ok | ok | ok | ok | ok |
| `plugins-count` | ok | ok | ok | ok | ok |
| `mimetypes-count` | ok | ok | ok | ok | ok |
| `plugins-integrity` | ok | ok | ok | ok | ok |
| `languages-empty` | ok | ok | ok | ok | ok |
| `language-first` | ok | ok | ok | ok | ok |
| `locale-intl` | ok | ok | ok | ok | ok |
| `notification-permission` | **FLAG** | ok | ok | ok | ok |
| `webgl-precision` | ok | ok | ok | ok | ok |
| `webgl-renderer` | ok | ok | ok | ok | ok |
| `hardware-concurrency` | ok | ok | ok | ok | ok |
| `device-memory` | ok | ok | ok | ok | ok |
| `outer-window` | ok | ok | ok | ok | ok |
| `outer-equals-inner` | ok | ok | ok | ok | ok |
| `outer-smaller-than-inner` | ok | **FLAG** | **FLAG** | ok | **FLAG** |
| `viewport-larger-than-screen` | ok | ok | **FLAG** | ok | **FLAG** |
| `screen-orientation` | **FLAG** | **FLAG** | **FLAG** | ok | **FLAG** |
| `window-fits-screen` | ok | ok | ok | ok | ok |
| `screen-default` | ok | **FLAG** | **FLAG** | ok | **FLAG** |
| `color-depth` | ok | ok | ok | ok | ok |
| `page-visible` | ok | ok | ok | ok | ok |
| `page-focus` | ok | ok | ok | ok | ok |
| `hairline` | ok | ok | ok | ok | ok |
| `iframe-chrome` | ok | ok | ok | ok | ok |
| `iframe-webdriver` | ok | **FLAG** | **FLAG** | ok | **FLAG** |
| `iframe-ua` | ok | **FLAG** | ok | ok | ok |
| `iframe-window-proxy` | ok | ok | ok | ok | ok |
| `codec-h264` | ok | ok | ok | ok | ok |
| `codec-aac` | ok | ok | ok | ok | ok |
| `audio-context` | ok | ok | ok | ok | ok |
| `fonts-installed` | ok | ok | ok | ok | ok |
| `accessor-receiver` | ok | ok | ok | ok | ok |
| `native-source` | ok | ok | ok | ok | ok |
| `ch-ua-header-headless` | ok | ok | ok | ok | ok |
| `accept-language` | ok | ok | ok | ok | ok |
| `worker-ua-headless` | ok | **FLAG** | ok | ok | ok |
| `worker-webdriver` | ok | ok | ok | ok | ok |
| `webgl-worker-renderer` | ok | ok | ok | ok | ok |
| `worker-matches-page` | **FLAG** | ok | ok | ok | ok |
| `worker-runtime-enabled` | ok | **FLAG** | **FLAG** | ok | **FLAG** |
| `cdp-runtime-enabled` | ok | **FLAG** | **FLAG** | ok | **FLAG** |
| `driver-main-world` | ok | **FLAG** | **FLAG** | ok | **FLAG** |
| **flagged of 49** | **3** | **11** | **9** | **0** | **9** |

`worker-runtime-enabled`, `cdp-runtime-enabled` and `driver-main-world` are the three CDP-side rows. `cdp-runtime-enabled` is true while a DevTools client has Runtime
enabled in the page (V8 formats a logged Error's stack, calling `Error.prepareStackTrace`, only then; raw CDP on Chrome 154 reads false before `Runtime.enable` and true after).
`driver-main-world` is true when a hook a site put on `document.getElementById` / `querySelector*` / `getBoundingClientRect` heard a call from outside the page's own
scripts (a driver name, or a frame with no script URL, which is what an evaluated string is).

### A cross-origin iframe (an out-of-process frame: its own renderer, CDP session and document start)

| browser | `navigator.webdriver` | HeadlessChrome in its User-Agent | Runtime enabled | WebGL renderer it reports |
|---|---|---|---|---|
| OMP browser | false | **true** | false | the host's |
| stock puppeteer | **true** | **true** | **true** | the host's |
| pack throwaway AFTER | false | false | false | the host's |
| pack View / saved profile | **true** | false | **true** | the host's |

OMP applies its User-Agent override to page-type targets only (`launch.ts:820-826`), so a cross-origin frame of an OMP page still says HeadlessChrome.

### A host with no GPU

Flagged signals with `--use-angle=swiftshader --enable-unsafe-swiftshader`:

| browser | flagged |
|---|---|
| OMP browser (5) | notification-permission, screen-orientation, worker-matches-page, **webgl-worker-renderer**, **webgl-precision** (its fake GPU is in the page; its worker's OffscreenCanvas still names SwiftShader; its precision formats still differ across float types) |
| stock puppeteer (13) | webdriver, ua-headless, **webgl-renderer**, outer-smaller-than-inner, screen-orientation, screen-default, iframe-webdriver, iframe-ua, worker-ua-headless, webgl-worker-renderer, worker-runtime-enabled, cdp-runtime-enabled, driver-main-world |
| pack View / saved profile, unchanged (11) | webdriver, **webgl-renderer**, outer-smaller-than-inner, viewport-larger-than-screen, screen-orientation, screen-default, iframe-webdriver, webgl-worker-renderer, worker-runtime-enabled, cdp-runtime-enabled, driver-main-world |
| pack throwaway AFTER (0) | none; the cross-origin frame and each worker report the masked Intel GPU too |

### What the OMP column flags, and why

- `worker-matches-page`: OMP pins `navigator.hardwareConcurrency` to 8 in the page and not in its workers, which report the real 32.
- `notification-permission`: on a plain-`http` origin (this page is `http://127.0.0.1`) OMP answers `permissions.query` "denied" while `Notification.permission` is "default". Not tested on `https`.
- `screen-orientation`: OMP's `setViewport` leaves a 1365x768 page reporting `portrait-primary`.
- with no GPU, `webgl-worker-renderer` and `webgl-precision` (above), and a HeadlessChrome User-Agent in cross-origin frames.

## Coverage of OMP: its 14 scripts, launch flags and patch, against this change

"Closed" names the place; a gap says what is left. Rows say `native` where the unpatched Chrome already answers as a person's.

| OMP | here |
|---|---|
| `00_stealth_tampering` (a native-source registry over `Function.prototype.toString`, every document) | Nothing replaced on a host with a GPU. With a software renderer: the mask's own `toString` Proxy, `src/engines/agent-browser.ts:162-175`. **Gap (same as OMP's):** a TypeError thrown through a wrapper shows an `Object.apply` frame (measured, no-GPU host). |
| `01_stealth_activity` (`hidden`, `hasFocus`) | `Emulation.setFocusEmulationEnabled` on every tab, `puppeteer.ts:582`; rows `page-visible`, `page-focus` ok. **Not tested:** a background tab's `visibilityState` (doc 77 §7.4.8 item 4). |
| `02_stealth_hairline` | native; row `hairline` ok. |
| `03_stealth_botd` | `navigator.webdriver`: the `AutomationControlled` Blink switch, `agent-browser.ts:52`, **headless only** (a window gets an "unsupported command-line flag" bar from it). `chrome.app/csi/loadTimes`, `chrome.runtime`: native; `chrome.runtime` is not faked (row `chrome-runtime` reports `undefined`, ok). `Notification`/`permissions`: native, ok **on http only; https not tested**. `cdc_`: chromedriver only, n/a. |
| `04_stealth_iframe` (iframe `contentWindow`) | native; rows `iframe-chrome`, `iframe-webdriver`, `iframe-ua`, `iframe-window-proxy` ok; a cross-origin frame measured (table above). The GPU mask in `srcdoc` / `about:blank` frames: by construction (a CDP document script runs in every frame), **not measured**. |
| `05_stealth_webgl` | Unmasked vendor/renderer in the page, each out-of-process frame and each dedicated/shared worker: `agent-browser.ts:162-190`, sent before the target runs by `shapeTargetEarly` (`:120-136`, called from `puppeteer.ts:267`). Float precision formats: `:195`. `getParameter(VENDOR/RENDERER)` is `WebKit` / `WebKit WebGL` natively, with or without a GPU (measured), as OMP's rewrite makes it. **Gap:** texture and uniform limits and the extension list stay SwiftShader's (measured: `MAX_TEXTURE_SIZE` 8192 against 16384 on the host GPU; 36 extensions against 35), as does the render hash. OMP changes none of these either. |
| `06_stealth_screen` | A device-metrics override and the window bounds: `agent-browser.ts:72-97`, again on every resize (`puppeteer.ts:1477`); for a popup or new tab the metrics go out before its first document (`shapeTargetEarly`), the window bounds when the tab is adopted (`puppeteer.ts:576`, so a popup's `outerWidth` at its very first script is not covered). |
| `07_stealth_fonts`, `08_stealth_audio`, `11_stealth_hardware`, `12_stealth_codecs` | Deliberately not invented; host-native. **Not closed on a bare VPS or container** (few fonts, no audio device, 1-2 cores). OMP pins `hardwareConcurrency` in the page and not in its workers, which is its own `worker-matches-page` flag. |
| `09_stealth_locale`, `10_stealth_plugins` | native (headless Chrome 154 has the PDF viewer plugins); rows ok. |
| `13_stealth_worker` (a wrapper that patches UA and platform in same-origin http(s) workers) | UA, client hints and platform on **every** target (blob and cross-origin workers, shared and service workers, frames): `presentAsHeadful`, `puppeteer.ts:265`. The worker's GPU: `shapeTargetEarly` (`:136`), sent on the worker's own session before it runs, a `Runtime.evaluate` into the paused worker, which needs no `Runtime.enable`. |
| Launch flags: `--enable-automation` | Dropped for every browser (`launch.ts:289`; the View's too, as before). **Edge exception not adopted:** OMP keeps it for Edge because Edge "can exit before CDP opens"; the pack drops it always and has not run Edge in this revision. |
| `--disable-popup-blocking`, `--disable-ipc-flooding-protection`, `--allow-pre-commit-input` | Dropped for an agent browser: `agent-browser.ts:60`, `launch.ts:289`. |
| `--disable-default-apps`, `--disable-component-extensions-with-background-pages`, `--disable-client-side-phishing-detection`, `--metrics-recording-only` | **Kept on purpose** (`puppeteer.ts` `CHROMIUM_ARGS`): they stop Chrome phoning home and a page cannot see them. OMP strips them as flag fingerprints (only `chrome://version` shows it). `--disable-extensions`: not stripped; a page cannot see it. |
| patch: `Runtime.enable` removal (`FrameManager`, `IsolatedWorld`, `WebWorker`) | `patches/puppeteer-core-25.11.0-agent.patch` (hunks at `:359-720`), applied while bundling `app/puppeteer-agent.mjs` (`scripts/agent-puppeteer.mjs`); loaded only for agent browsers (`puppeteer.ts:307`, `:390`). The View and saved profiles keep the stock library (relay test and profile test hold it). |
| patch: DOM work in the utility world, `//!world=main` opt-in | same patch (`api/Frame.js`, `api/ElementHandle.js`, `common/QueryHandler.js`). The model's own `eval` goes by raw `Runtime.evaluate` in the page's world, unchanged. A page's own override of a DOM method no longer reaches the pack's reads on a throwaway (`test/act-batch.test.ts`). |
| patch: no `__puppeteer_evaluation_script__` / `pptr:` sourceURL | same patch (`cdp/ExecutionContext.js`); replaces the pack's earlier `_rawSend` strip. |
| patch: default `--disable-features` list dropped | same patch (`node/ChromeLauncher.js`). |
| patch: exposeFunction bindings in the main world | ported (`cdp/Frame.js`); the pack exposes no bindings. |
| OMP's main-world bootstrap (14 scripts in one `evaluateOnNewDocument`, a hidden iframe appended in every document) | Not done: the pack's only document-start page scripts are the GPU mask (software renderer hosts) and the loopback-only error reporter. |

**What the Runtime patch costs the pack, and what replaces it.** Without Runtime events `page.on("console")` and `pageerror` are dead for an agent browser. The page log
takes console errors and warnings from the Console domain (measured: `Console.enable` does not make the Runtime probe true). An uncaught exception or unhandled rejection
needs a listener in the page; one is installed **only for loopback pages** (`page-log.ts:56`), so exceptions are logged for the app under test on localhost and
**not logged on the public web**. That is a real loss against the earlier behaviour, made on purpose; the alternative was a script on every page.

## Public pages

- `https://bot.sannysoft.com` was measured on revision 1 of this change and **not re-run** on revision 2 (no change since touches what it reads except the Runtime probe).
- `https://arh.antoinevastel.com/bots/areyouheadless` was down on revision 1 (502) and not retried.

## Cost of the change

Same machine, other work running on it, the columns run one after another in separate processes; "cold" is the first open in a process (it includes the once-per-binary
identity probe both versions pay). Open = `runtime.open({})` / `launch` + `newPage`; first navigation = to a 1 KB local page. Later runs: median (IQR), n = 15.

| | open, cold | open, later | first navigation, later |
|---|---|---|---|
| stock puppeteer | 453 ms | 389 ms (378-418) | 29 ms (24-38) |
| OMP browser | 437 ms | 437 ms (397-519) | 31 ms (27-34) |
| pack throwaway BEFORE | 1014 ms | 349 ms (333-367) | 28 ms (26-33) |
| pack throwaway AFTER | 962 ms | 352 ms (322-392) | 29 ms (25-43) |
| pack View / saved profile | 835 ms | 316 ms (297-342) | 25 ms (21-32) |

Differences under about 100 ms are noise here (the saved-profile control moved from 355 ms to 316 ms between two of my own runs of identical code). Honest reading: no
measurable cost for a throwaway's later opens or first navigation; its cold open is the identity probe, not this change (BEFORE pays it too).

browser_read, `BrowserRuntime.read` of the 1 KB page, four processes each (cold = the first read in the process, which launches the reader; warm = median of the next five):

| | cold first read | warm read, medians |
|---|---|---|
| BEFORE | 424, 454, 478, 513 ms | 151, 186, 209, 161 ms |
| AFTER | 606, 630, 708, 907 ms | 238, 256, 183, 170 ms |

The reader's first read is about 200 ms slower, once per process: the patched library loads (about 50 ms) and the reader reads its identity from its own browser (a blank page,
two evaluates) instead of a probe Chrome launched in front of it, which revision 1 did (it cost 600-1000 ms). A warm read is within the noise of the four runs.

## Not measured

- A real headful Chrome (no visible window was opened on a machine that may have a game in front); "what a person's Chrome reports" is the browser's own values for the signals left alone.
- One GPU (this host's NVIDIA) and a simulated GPU-less Chrome; no real GPU-less machine, no Linux or macOS run, no Edge or Chrome for Testing in revision 2.
- Commercial bot walls (Cloudflare, DataDome, Akamai). The page covers property tells, `Runtime.enable`, hooked page APIs, a worker and a cross-origin frame. It does **not** cover
  canvas 2D / audio render hashes and their noise, timing (`rAF` cadence, `performance.now` granularity), input behaviour (a `mouse.click` teleports to an exact centre with no
  prior `mousemove`; keystrokes have no timing variance), `speechSynthesis` voices, `mediaDevices.enumerateDevices`, `Notification` on an `https` origin, or a background tab.
- `webgl-precision` and the limits above judge SwiftShader against this host's GPU, not against a table of real GPUs.

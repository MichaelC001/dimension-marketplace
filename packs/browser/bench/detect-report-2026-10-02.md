# Headless detection: what the pack's browsers show a bot check (2026-10-02)

Measured, not argued. Every number below comes from a run on this machine (Windows 11, Ryzen 9 9950X3D, an NVIDIA GPU, Google Chrome 154.0.8037.x
unless a row says otherwise). `bench/sites/detect.mjs` is a local page with no network need: it reads 47 signals a public bot check reads and says
for each whether a detector would flag it. It is OUR page, written for this work, so it shows which signals a change closes; it does not rank the
browsers against a detector we did not write (the public pages are below).

How each column was driven:

- **OMP browser (14 scripts)**: OMP's own `launchHeadlessBrowser`, `applyStealthPatches` and `applyViewport` (`omp/packages/coding-agent/src/tools/browser/launch.ts`),
  called in that order as `tab-worker.ts` calls them, on the same Chrome (`PUPPETEER_EXECUTABLE_PATH`). Not a re-creation of its flags.
- **stock puppeteer**: `puppeteer-core` 25.11.0 `launch({headless: true})`, nothing else.
- **pack throwaway**: `BrowserRuntime.open({})` (no profile), then `act navigate`. BEFORE is `origin/main` (188ca45) `packs/browser/src`; AFTER is this change.
- **pack View / saved profile**: `BrowserRuntime.open({profile})`, the path the View and every saved profile take. Unchanged by this change: BEFORE and AFTER were measured and are identical.
- **reader**: `BrowserRuntime.read` (browser_read). Its page cannot POST (requests are screened), so it reads the signals from the page's own text; the rows that need a worker, a server round trip or the driver acting first are `n/a`.

## The signals, one by one

`FLAG` = the page saw a signal a bot check flags.

| signal | OMP browser (14 scripts) | stock puppeteer | pack throwaway BEFORE | pack throwaway AFTER | pack View / saved profile (unchanged) | reader BEFORE | reader AFTER |
|---|---|---|---|---|---|---|---|
| `webdriver` | ok | **FLAG** | **FLAG** | ok | **FLAG** | **FLAG** | ok |
| `navigator-own-properties` | ok | ok | ok | ok | ok | ok | ok |
| `ua-headless` | ok | **FLAG** | ok | ok | ok | **FLAG** | ok |
| `ua-data-headless` | ok | ok | ok | ok | ok | ok | ok |
| `platform-consistent` | ok | ok | ok | ok | ok | ok | ok |
| `chrome-object` | ok | ok | ok | ok | ok | ok | ok |
| `chrome-parts` | ok | ok | ok | ok | ok | ok | ok |
| `chrome-runtime` | ok | ok | ok | ok | ok | ok | ok |
| `plugins-count` | ok | ok | ok | ok | ok | ok | ok |
| `mimetypes-count` | ok | ok | ok | ok | ok | ok | ok |
| `plugins-integrity` | ok | ok | ok | ok | ok | ok | ok |
| `languages-empty` | ok | ok | ok | ok | ok | ok | ok |
| `language-first` | ok | ok | ok | ok | ok | ok | ok |
| `locale-intl` | ok | ok | ok | ok | ok | ok | ok |
| `notification-permission` | **FLAG** | ok | ok | ok | ok | ok | ok |
| `webgl-renderer` | ok | ok | ok | ok | ok | ok | ok |
| `hardware-concurrency` | ok | ok | ok | ok | ok | ok | ok |
| `device-memory` | ok | ok | ok | ok | ok | ok | ok |
| `outer-window` | ok | ok | ok | ok | ok | ok | ok |
| `outer-equals-inner` | ok | ok | ok | ok | ok | ok | ok |
| `outer-smaller-than-inner` | ok | **FLAG** | **FLAG** | ok | **FLAG** | **FLAG** | ok |
| `viewport-larger-than-screen` | ok | ok | **FLAG** | ok | **FLAG** | **FLAG** | ok |
| `screen-orientation` | **FLAG** | **FLAG** | **FLAG** | ok | **FLAG** | **FLAG** | ok |
| `window-fits-screen` | ok | ok | ok | ok | ok | ok | ok |
| `screen-default` | ok | **FLAG** | **FLAG** | ok | **FLAG** | **FLAG** | ok |
| `color-depth` | ok | ok | ok | ok | ok | ok | ok |
| `page-visible` | ok | ok | ok | ok | ok | ok | ok |
| `page-focus` | ok | ok | ok | ok | ok | ok | ok |
| `hairline` | ok | ok | ok | ok | ok | ok | ok |
| `iframe-chrome` | ok | ok | ok | ok | ok | ok | ok |
| `iframe-webdriver` | ok | **FLAG** | **FLAG** | ok | **FLAG** | **FLAG** | ok |
| `iframe-ua` | ok | **FLAG** | ok | ok | ok | **FLAG** | ok |
| `iframe-window-proxy` | ok | ok | ok | ok | ok | ok | ok |
| `codec-h264` | ok | ok | ok | ok | ok | ok | ok |
| `codec-aac` | ok | ok | ok | ok | ok | ok | ok |
| `audio-context` | ok | ok | ok | ok | ok | ok | ok |
| `fonts-installed` | ok | ok | ok | ok | ok | ok | ok |
| `accessor-receiver` | ok | ok | ok | ok | ok | ok | ok |
| `native-source` | ok | ok | ok | ok | ok | ok | ok |
| `ch-ua-header-headless` | ok | ok | ok | ok | ok | n/a | n/a |
| `accept-language` | ok | ok | ok | ok | ok | n/a | n/a |
| `worker-ua-headless` | ok | **FLAG** | ok | ok | ok | n/a | n/a |
| `worker-webdriver` | ok | ok | ok | ok | ok | n/a | n/a |
| `webgl-worker-renderer` | ok | ok | ok | ok | ok | n/a | n/a |
| `worker-matches-page` | **FLAG** | ok | ok | ok | ok | n/a | n/a |
| `cdp-runtime-enabled` | ok | ok | ok | ok | ok | n/a | n/a |
| `driver-sourceurl` | ok | **FLAG** | **FLAG** | ok | **FLAG** | n/a | n/a |
| **flagged** | 3 | 9 | 7 | 0 | 7 | 8 | 0 |

Also measured, same page, not shown above because they change nothing: Chrome for Testing 153 and Microsoft Edge 154 (pack throwaway AFTER: 0 flagged on both).

### A host with no GPU

The same runs with `--use-angle=swiftshader --enable-unsafe-swiftshader` (what a CI box or a VPS has by default):

| browser | flagged |
|---|---|
| OMP browser | notification-permission, screen-orientation, worker-matches-page (its fake-GPU script closes `webgl-renderer`) |
| stock puppeteer | webdriver, ua-headless, **webgl-renderer**, outer-smaller-than-inner, screen-orientation, screen-default, iframe-webdriver, iframe-ua, worker-ua-headless, driver-sourceurl |
| pack View / saved profile (unchanged) | webdriver, **webgl-renderer**, outer-smaller-than-inner, viewport-larger-than-screen, screen-orientation, screen-default, iframe-webdriver, driver-sourceurl |
| pack throwaway AFTER | none |
| reader AFTER | none |

A worker's `OffscreenCanvas` still reports the host's renderer (`webgl-worker-renderer`, information only): a page-script mask does not reach workers.

### What the OMP column flags, and why

- `worker-matches-page`: OMP pins `navigator.hardwareConcurrency` to 8 in the page and does not in its workers, which report the real 32.
- `notification-permission`: on a plain-`http` origin (this page is `http://127.0.0.1`) OMP answers `permissions.query` "denied" while `Notification.permission` is "default". On an `https` origin it patches the other way. Not tested on an `https` origin here.
- `screen-orientation`: OMP's `setViewport` leaves a 1365x768 page reporting `portrait-primary`.

## Public pages

- `https://bot.sannysoft.com`, page text parsed, 5 s after load. Tests the page marks failed: stock puppeteer **3** (WebDriver (New), HEADCHR_UA, CHR_MEMORY); pack View / saved profile (unchanged path) **1** (WebDriver (New)); pack throwaway **0**; OMP browser **0**. Passed counts 19 / 21 / 22 / 22.
- `https://arh.antoinevastel.com/bots/areyouheadless`: **not reachable**. The server answered `502 Bad Gateway` (nginx) on four tries over two minutes, so no row. A substitute (`fingerprintjs.github.io/BotD/main/`) is a 404.

## Cost of the change

Same machine, other work running on it (the noise is large), `origin/main` source and this change run alternately in separate processes, `runtime.open` / first navigation to a 1 KB local page. "Cold" is the first open in a process: it includes the once-per-binary identity probe that both versions already pay.

| | before | after |
|---|---|---|
| throwaway, cold open (median of 3 processes) | 1476 ms | 1385 ms |
| throwaway, later opens (median, IQR; n = 15) | 671 ms (471-877) | 465 ms (397-585) |
| throwaway, first navigation (median, IQR; n = 15) | 79 ms (45-136) | 63 ms (38-76) |
| View / saved profile, later opens (control: unchanged code; n = 15) | 487 ms (444-609) | 541 ms (481-637) |
| reader, cold first read (4 processes) | 528, 563, 734, 836 ms | 1145, 1428, 1603, 1885 ms |
| reader, later launch + first read (median, IQR; n = 28) | 609 ms (537-660) | 630 ms (579-773) |
| reader, a second read on the warm reader (median) | 254 ms | 256 ms |

The control row (code this change does not touch) moved by 54 ms between runs: differences under about 100 ms here are noise. Honest reading: no measurable cost for a throwaway browser or a warm reader; the reader's first read in a process is about 0.9 s slower, once, because it now needs the binary's identity (a throwaway launch of Chrome, cached per binary) which the View path had already needed. If the View probed the same binary earlier in that process the reader pays nothing.

## Not verified

- A real headful Chrome was not run (no visible window was opened on a machine that may have a game in front); "what a person's Chrome reports" is the browser's own values for the signals we leave alone, not a capture of a headful window.
- Only this host's GPU and a simulated GPU-less Chrome; no real GPU-less machine, no Linux or macOS run.
- No third-party detector beyond bot.sannysoft.com. Commercial bot walls (Cloudflare, DataDome, Akamai) were not tested. OMP's patched `puppeteer-core` DOES remove CDP `Runtime.enable` (`omp/patches/puppeteer-core@25.3.0.patch:357-368` FrameManager, `:562-595` IsolatedWorld, `:600-624` WebWorker); stock `puppeteer-core` 25.11.0 sends it on every page and every out-of-process frame (`FrameManager.js:260`), and at the commit this report was first written this change did not remove it. The `cdp-runtime-enabled` row in the table above reported `ok` for stock puppeteer, which sends it, so that row measured nothing; it is being replaced by a probe that is true under stock puppeteer.
- `arh.antoinevastel.com` was down.

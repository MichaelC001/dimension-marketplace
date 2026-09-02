// Standalone Google Meet caption-scraper bot. Runs as a DETACHED subprocess
// (`bun bot/meet-bot.ts`), spawned by ../bot.ts. All config comes from env; all
// output goes to files under MEET_OUT_DIR — there is NO IPC beyond the filesystem
// (status.json + transcript.txt), exactly like Hermes' meet_bot.py.
//
// Strategy (ported from Hermes / OpenUtter): we do NOT touch WebRTC audio. We
// join the call, enable Meet's own live captions, and observe the caption DOM via
// a MutationObserver. Lossy and English-biased, but deterministic, key-free, and
// resilient to Meet rewrites because the caption region has a stable ARIA role.
//
// Env in:
//   MEET_URL         (required)  https://meet.google.com/... — gated by MEET_URL_RE
//   MEET_OUT_DIR     (required)  directory for status.json / transcript.txt / bot.log
//   MEET_GUEST_NAME  (optional)  display name; default "Dimension Agent"
//   MEET_DURATION    (optional)  auto-leave after e.g. "30m" / "90s" / "2h"
//   MEET_HEADED      (optional)  "1" → visible browser (debugging)
import { appendFileSync, existsSync, mkdirSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Browser as BrowserEnum, computeExecutablePath, detectBrowserPlatform } from "@puppeteer/browsers";
import type { BrowserPlatform } from "@puppeteer/browsers";
// Pinned Chrome revision, used only to derive the cache-dir path for an EXISTING
// install (never to download). Same subpath omp's browser/launch.ts reads.
import { PUPPETEER_REVISIONS } from "puppeteer-core/internal/revisions.js";
import type { Browser, Page, default as Puppeteer } from "puppeteer-core";
import { MEET_URL_RE, meetingIdFromUrl } from "./meet-url";

// ---------------------------------------------------------------------------
// Paths + config
// ---------------------------------------------------------------------------

const CONFIG_ROOT = join(homedir(), ".config", "dimension-google-meet");
const CHROMIUM_CACHE_DIR = join(CONFIG_ROOT, "chromium");
const PROFILE_DIR = join(CONFIG_ROOT, "chrome-profile");
// A clean scratch dir with an empty package.json so puppeteer-core's cosmiconfig
// cwd probe doesn't choke on a malformed package.json in the real project tree.
const SCRATCH_DIR = join(CONFIG_ROOT, "pptr-scratch");

const LOBBY_TIMEOUT_MS = 300_000; // 5 min waiting for host admission → give up.
const NAV_TIMEOUT_MS = 30_000;
const JOIN_ATTEMPT_MS = 25_000; // window to find + click a Join/Ask button.
const TICK_MS = 1_000;

/** Parse "30m" / "90s" / "2h" / "90" (bare = seconds) → milliseconds, or undefined. */
function parseDurationMs(raw: string): number | undefined {
	const s = (raw ?? "").trim().toLowerCase();
	if (!s) return undefined;
	const m = /^(\d+(?:\.\d+)?)(h|m|s)?$/.exec(s);
	if (!m) return undefined;
	const n = Number(m[1]);
	if (!Number.isFinite(n)) return undefined;
	const unit = m[2] ?? "s";
	const mult = unit === "h" ? 3_600_000 : unit === "m" ? 60_000 : 1_000;
	return n * mult;
}

function hhmmss(d: Date): string {
	const p = (n: number) => String(n).padStart(2, "0");
	return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

// ---------------------------------------------------------------------------
// Chromium resolution — system Chrome → PUPPETEER_EXECUTABLE_PATH → cache dir.
// Never downloads (a 150 MB silent fetch is a footgun); emits a clear error.
// ---------------------------------------------------------------------------

function isExecutableFile(p: string): boolean {
	try {
		return statSync(p).isFile();
	} catch {
		return false;
	}
}

function systemChromiumCandidates(): string[] {
	const home = homedir();
	const out: string[] = [];
	switch (process.platform) {
		case "darwin": {
			for (const root of ["/Applications", join(home, "Applications")]) {
				out.push(
					join(root, "Google Chrome.app/Contents/MacOS/Google Chrome"),
					join(root, "Google Chrome Beta.app/Contents/MacOS/Google Chrome Beta"),
					join(root, "Chromium.app/Contents/MacOS/Chromium"),
					join(root, "Microsoft Edge.app/Contents/MacOS/Microsoft Edge"),
				);
			}
			break;
		}
		case "linux": {
			for (const name of ["google-chrome-stable", "google-chrome", "chromium", "chromium-browser", "chrome"]) {
				const found = Bun.which(name);
				if (found) out.push(found);
			}
			out.push(
				"/usr/bin/google-chrome-stable",
				"/usr/bin/google-chrome",
				"/usr/bin/chromium",
				"/usr/bin/chromium-browser",
				"/snap/bin/chromium",
			);
			break;
		}
		case "win32": {
			const programFiles = process.env.ProgramFiles ?? "C:\\Program Files";
			const programFilesX86 = process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)";
			const localAppData = process.env.LOCALAPPDATA ?? join(home, "AppData\\Local");
			out.push(
				join(programFiles, "Google\\Chrome\\Application\\chrome.exe"),
				join(programFilesX86, "Google\\Chrome\\Application\\chrome.exe"),
				join(localAppData, "Google\\Chrome\\Application\\chrome.exe"),
				join(programFiles, "Chromium\\Application\\chrome.exe"),
				join(localAppData, "Chromium\\Application\\chrome.exe"),
				join(programFiles, "Microsoft\\Edge\\Application\\msedge.exe"),
				join(programFilesX86, "Microsoft\\Edge\\Application\\msedge.exe"),
			);
			break;
		}
	}
	return out;
}

function resolveSystemChromium(): string | undefined {
	const seen = new Set<string>();
	for (const c of systemChromiumCandidates()) {
		if (!c || seen.has(c)) continue;
		seen.add(c);
		if (isExecutableFile(c)) return c;
	}
	return undefined;
}

/** Scan the cache dir for a Chrome install at any buildId (not just the pinned one). */
function scanCacheForChrome(cacheDir: string, platform: BrowserPlatform): string | undefined {
	const chromeDir = join(cacheDir, "chrome");
	let entries: string[];
	try {
		entries = readdirSync(chromeDir);
	} catch {
		return undefined;
	}
	const prefix = `${platform}-`;
	for (const entry of entries) {
		if (!entry.startsWith(prefix)) continue;
		const buildId = entry.slice(prefix.length);
		try {
			const exe = computeExecutablePath({ browser: BrowserEnum.CHROME, buildId, cacheDir, platform });
			if (existsSync(exe)) return exe;
		} catch {
			// malformed cache entry — skip
		}
	}
	return undefined;
}

function resolveChromiumExecutable(cacheDir: string): string | undefined {
	const sys = resolveSystemChromium();
	if (sys) return sys;
	const envPath = process.env.PUPPETEER_EXECUTABLE_PATH;
	if (envPath && isExecutableFile(envPath)) return envPath;
	const platform = detectBrowserPlatform();
	if (!platform) return undefined;
	// The pinned revision IS the chrome buildId — compute the cache path directly
	// (no network, no resolveBuildId round-trip) and only accept it if present.
	try {
		const exe = computeExecutablePath({
			browser: BrowserEnum.CHROME,
			buildId: PUPPETEER_REVISIONS.chrome,
			cacheDir,
			platform,
		});
		if (existsSync(exe)) return exe;
	} catch {
		// fall through to the broader scan
	}
	return scanCacheForChrome(cacheDir, platform);
}

/**
 * Lazy-load puppeteer-core from a safe cwd. Dynamic import is REQUIRED here (not a
 * style choice): puppeteer-core runs a cosmiconfig cwd probe at module-load time,
 * so we must `process.chdir` to a clean scratch dir BEFORE the module initializes —
 * a static import would evaluate at parse time, before cwd is safe. Mirrors
 * omp/packages/coding-agent/src/tools/browser/launch.ts `loadPuppeteer()`.
 */
async function loadPuppeteer(): Promise<typeof Puppeteer> {
	mkdirSync(SCRATCH_DIR, { recursive: true });
	writeFileSync(join(SCRATCH_DIR, "package.json"), "{}");
	const prev = process.cwd();
	try {
		process.chdir(SCRATCH_DIR);
		return (await import("puppeteer-core")).default;
	} finally {
		process.chdir(prev);
	}
}

// ---------------------------------------------------------------------------
// Injected page scripts. Caption selectors ported VERBATIM from Hermes'
// `_CAPTION_OBSERVER_JS` — they are the current-Meet-DOM ground truth. Only the
// window globals are renamed (__hermesMeet* → __meet*).
// ---------------------------------------------------------------------------

const CAPTION_OBSERVER_JS = String.raw`
(() => {
  if (window.__meetInstalled) return;
  window.__meetInstalled = true;
  window.__meetQueue = [];

  const captionSelector = '[role="region"][aria-label*="aption" i], ' +
                          'div[jsname="YSxPC"], ' +  // legacy
                          'div[jsname="tgaKEf"]';    // current (Apr 2026)

  function pushEntry(speaker, text) {
    if (!text || !text.trim()) return;
    window.__meetQueue.push({
      ts: Date.now(),
      speaker: (speaker || '').trim(),
      text: text.trim(),
    });
  }

  function scan(root) {
    // Meet captions render as a list of rows; each row contains a speaker
    // label and a text block. Selectors vary across Meet rewrites; we try
    // a few shapes and fall back to raw text.
    const rows = root.querySelectorAll('div[jsname="dsyhDe"], div.CNusmb, div.TBMuR');
    if (rows.length) {
      rows.forEach((row) => {
        const spkEl = row.querySelector('div.KcIKyf, div.zs7s8d, span[jsname="YSxPC"]');
        const txtEl = row.querySelector('div.bh44bd, span[jsname="tgaKEf"], div.iTTPOb');
        const speaker = spkEl ? spkEl.innerText : '';
        const text = txtEl ? txtEl.innerText : row.innerText;
        pushEntry(speaker, text);
      });
      return;
    }
    // Fallback: treat the whole region's innerText as one anonymous line.
    const text = (root.innerText || '').split('\n').filter(Boolean).pop();
    pushEntry('', text);
  }

  function attach() {
    const el = document.querySelector(captionSelector);
    if (!el) return false;
    const obs = new MutationObserver(() => scan(el));
    obs.observe(el, { childList: true, subtree: true, characterData: true });
    scan(el);
    return true;
  }

  // Try now and retry on interval — the caption region only appears after
  // captions are enabled and someone speaks.
  if (!attach()) {
    const iv = setInterval(() => { if (attach()) clearInterval(iv); }, 1500);
  }

  window.__meetDrain = () => {
    const out = window.__meetQueue.slice();
    window.__meetQueue = [];
    return out;
  };
})();
`;

// Best-effort caption enable — Meet's toggle is keyboard-accessible via `c`.
const ENABLE_CAPTIONS_JS = String.raw`
(() => {
  const ev = new KeyboardEvent('keydown', {
    key: 'c', code: 'KeyC', keyCode: 67, which: 67, bubbles: true,
  });
  document.body.dispatchEvent(ev);
  return true;
})();
`;

const DRAIN_JS = "window.__meetDrain ? window.__meetDrain() : []";

// Admission probe — ported verbatim (globals renamed). True once we're clearly
// past the lobby: Leave button, caption region, or participants panel present.
const ADMISSION_JS = String.raw`
(() => {
  const leave = document.querySelector('button[aria-label*="eave call" i]');
  if (leave) return true;
  if (window.__meetInstalled) {
    const caps = document.querySelector(
      '[role="region"][aria-label*="aption" i], ' +
      'div[jsname="YSxPC"], div[jsname="tgaKEf"]'
    );
    if (caps) return true;
  }
  const parts = document.querySelector('[aria-label*="articipants" i]');
  if (parts) return true;
  return false;
})();
`;

// Denial probe — ported verbatim. English-only, matches Meet's denied/removed copy.
const DENIED_JS = String.raw`
(() => {
  const text = document.body ? document.body.innerText || '' : '';
  if (/You can't join this video call/i.test(text)) return true;
  if (/You were removed from the meeting/i.test(text)) return true;
  if (/No one responded to your request to join/i.test(text)) return true;
  return false;
})();
`;

const LEAVE_CALL_JS = String.raw`
(() => { const b = document.querySelector('button[aria-label*="eave call" i]'); if (b) { b.click(); return true; } return false; })();
`;

/** Build a script that clicks the first visible button/[role=button] whose text or
 *  aria-label contains any of `labels` (lowercased). Returns the matched text or null. */
function clickLabelsJs(labels: string[]): string {
	return String.raw`
(() => {
  const wanted = ${JSON.stringify(labels.map(l => l.toLowerCase()))};
  const els = Array.from(document.querySelectorAll('button, [role="button"]'));
  for (const el of els) {
    const t = (((el.innerText || '') + ' ' + (el.getAttribute('aria-label') || ''))).toLowerCase();
    if (wanted.some((w) => t.includes(w))) {
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) { el.click(); return t.trim(); }
    }
  }
  return null;
})();
`;
}

// ---------------------------------------------------------------------------
// Bot state — flushed to status.json (atomic tmp+rename) on every change.
// ---------------------------------------------------------------------------

interface CaptionEntry {
	ts: number;
	speaker: string;
	text: string;
}

class BotState {
	readonly outDir: string;
	readonly meetingId: string;
	readonly url: string;
	readonly transcriptPath: string;
	private readonly statusPath: string;
	private readonly seen = new Set<string>();

	inCall = false;
	lobbyWaiting = false;
	captioning = false;
	captionsEnabledAttempted = false;
	joinAttemptedAt: number | null = null;
	joinedAt: number | null = null;
	lastCaptionAt: number | null = null;
	transcriptLines = 0;
	error: string | null = null;
	exited = false;
	leaveReason: string | null = null;
	readonly startedAt = Date.now();
	readonly pid = process.pid;

	constructor(outDir: string, meetingId: string, url: string) {
		this.outDir = outDir;
		this.meetingId = meetingId;
		this.url = url;
		mkdirSync(outDir, { recursive: true });
		this.transcriptPath = join(outDir, "transcript.txt");
		this.statusPath = join(outDir, "status.json");
		this.flush();
	}

	/** Append a caption line if this exact (speaker, text) is new. */
	recordCaption(speakerRaw: string, textRaw: string): void {
		const speaker = (speakerRaw || "").trim() || "Unknown";
		const text = (textRaw || "").trim();
		if (!text) return;
		const key = `${speaker}|${text}`;
		if (this.seen.has(key)) return;
		this.seen.add(key);
		this.transcriptLines += 1;
		this.lastCaptionAt = Date.now();
		const line = `[${hhmmss(new Date(this.lastCaptionAt))}] ${speaker}: ${text}\n`;
		appendFileSync(this.transcriptPath, line, "utf8");
		this.flush();
	}

	set(patch: Partial<BotState>): void {
		Object.assign(this, patch);
		this.flush();
	}

	flush(): void {
		const data = {
			meetingId: this.meetingId,
			url: this.url,
			inCall: this.inCall,
			lobbyWaiting: this.lobbyWaiting,
			captioning: this.captioning,
			captionsEnabledAttempted: this.captionsEnabledAttempted,
			joinAttemptedAt: this.joinAttemptedAt,
			joinedAt: this.joinedAt,
			lastCaptionAt: this.lastCaptionAt,
			transcriptLines: this.transcriptLines,
			transcriptPath: this.transcriptPath,
			error: this.error,
			exited: this.exited,
			pid: this.pid,
			leaveReason: this.leaveReason,
			startedAt: this.startedAt,
		};
		const tmp = `${this.statusPath}.tmp`;
		writeFileSync(tmp, JSON.stringify(data, null, 2), "utf8");
		renameSync(tmp, this.statusPath);
	}
}

// ---------------------------------------------------------------------------
// Page helpers
// ---------------------------------------------------------------------------

async function dismissDeviceCheck(page: Page): Promise<void> {
	// Meet's device-check interstitial: take the "continue without microphone"
	// path when a mic isn't available (we launch with fake devices, so this is
	// usually a no-op, but headless environments without them hit it).
	try {
		await page.evaluate(
			clickLabelsJs([
				"continue without microphone and camera",
				"continue without microphone",
				"continue without camera",
				"use without microphone",
				"join without microphone",
				"continue anyway",
			]),
		);
	} catch {
		// interstitial not present
	}
}

async function setGuestName(page: Page, name: string): Promise<void> {
	// Only present in guest mode (not signed in). Meet's field is aria-labelled/
	// placeheld "Your name".
	try {
		const el = await page.$('input[aria-label*="name" i], input[placeholder*="name" i]');
		if (!el) return;
		await el.click({ count: 3 });
		await el.type(name, { delay: 20 });
	} catch {
		// name field not shown
	}
}

async function clickJoin(page: Page): Promise<"join_now" | "ask_to_join" | null> {
	try {
		const now = (await page.evaluate(clickLabelsJs(["join now"]))) as string | null;
		if (now) return "join_now";
		const ask = (await page.evaluate(clickLabelsJs(["ask to join"]))) as string | null;
		if (ask) return "ask_to_join";
	} catch {
		// buttons not present yet
	}
	return null;
}

async function enableCaptions(page: Page): Promise<void> {
	try {
		await page.keyboard.press("c");
	} catch {
		// keyboard shortcut unavailable
	}
	try {
		await page.evaluate(ENABLE_CAPTIONS_JS);
	} catch {
		// dispatch failed
	}
}

async function probe(page: Page, js: string): Promise<boolean> {
	try {
		return Boolean(await page.evaluate(js));
	} catch {
		return false;
	}
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

async function run(): Promise<number> {
	const url = (process.env.MEET_URL ?? "").trim();
	const outDirEnv = (process.env.MEET_OUT_DIR ?? "").trim();
	const guestName = process.env.MEET_GUEST_NAME || "Dimension Agent";
	const headed = ["1", "true", "yes"].includes((process.env.MEET_HEADED ?? "").toLowerCase());
	const durationMs = parseDurationMs(process.env.MEET_DURATION ?? "");

	if (!url || !MEET_URL_RE.test(url)) {
		process.stderr.write(
			`google-meet bot: refusing to launch — MEET_URL must be a meet.google.com URL. got: ${JSON.stringify(url)}\n`,
		);
		return 2;
	}
	if (!outDirEnv) {
		process.stderr.write("google-meet bot: MEET_OUT_DIR is required\n");
		return 2;
	}

	const meetingId = meetingIdFromUrl(url);
	const state = new BotState(outDirEnv, meetingId, url);

	// SIGTERM/SIGINT → flip a flag so the loop exits and the browser tears down
	// cleanly (finalized transcript). On Windows these may not be deliverable
	// (the parent hard-kills instead), but each tick already flushes atomically.
	const stop = { requested: false };
	const onSignal = () => {
		stop.requested = true;
	};
	process.on("SIGTERM", onSignal);
	process.on("SIGINT", onSignal);

	// Resolve Chromium up front — never download.
	const executablePath = resolveChromiumExecutable(CHROMIUM_CACHE_DIR);
	if (!executablePath) {
		state.set({
			error:
				"No Chrome/Chromium found — install Google Chrome or set PUPPETEER_EXECUTABLE_PATH to an existing " +
				`Chrome/Chromium binary (checked system install, PUPPETEER_EXECUTABLE_PATH, and ${CHROMIUM_CACHE_DIR}).`,
			exited: true,
		});
		return 5;
	}

	let puppeteer: typeof Puppeteer;
	try {
		puppeteer = await loadPuppeteer();
	} catch (err) {
		state.set({ error: `puppeteer-core failed to load: ${(err as Error).message}`, exited: true });
		return 3;
	}

	mkdirSync(PROFILE_DIR, { recursive: true });
	let browser: Browser;
	try {
		browser = await puppeteer.launch({
			headless: !headed,
			executablePath,
			userDataDir: PROFILE_DIR, // persistent context — a signed-in profile is reused across runs
			defaultViewport: headed ? null : { width: 1280, height: 800 },
			protocolTimeout: 60_000,
			ignoreDefaultArgs: ["--enable-automation"],
			args: [
				"--no-sandbox",
				"--disable-setuid-sandbox",
				"--disable-blink-features=AutomationControlled",
				// Fake (silent) mic/cam so no real devices are granted and no
				// permission prompt blocks the join.
				"--use-fake-ui-for-media-stream",
				"--use-fake-device-for-media-stream",
				"--window-size=1280,800",
			],
		});
	} catch (err) {
		state.set({ error: `browser launch failed: ${(err as Error).message}`, exited: true });
		return 6;
	}

	try {
		const pages = await browser.pages();
		const page = pages[0] ?? (await browser.newPage());
		await page.setUserAgent(
			"Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
		);

		try {
			await page.goto(url, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT_MS });
		} catch (err) {
			state.set({ error: `navigate failed: ${(err as Error).message}`, exited: true });
			await browser.close().catch(() => {});
			return 4;
		}

		// Pre-join: dismiss the device interstitial, set the guest name, click join.
		const joinDeadline = Date.now() + JOIN_ATTEMPT_MS;
		let joinKind: "join_now" | "ask_to_join" | null = null;
		while (!stop.requested && Date.now() < joinDeadline) {
			await dismissDeviceCheck(page);
			await setGuestName(page, guestName);
			joinKind = await clickJoin(page);
			if (joinKind) break;
			await Bun.sleep(1_000);
		}
		state.set({
			joinAttemptedAt: Date.now(),
			lobbyWaiting: joinKind === "ask_to_join",
		});

		// Enable captions + install the observer. Re-run cheaply each tick (the
		// observer IIFE self-guards) so an SPA document swap re-installs it.
		await enableCaptions(page);
		await page.evaluate(CAPTION_OBSERVER_JS).catch(() => {});
		state.set({ captioning: true, captionsEnabledAttempted: true });

		// Admission + drain loop.
		const deadline = durationMs ? Date.now() + durationMs : null;
		const lobbyDeadline = Date.now() + LOBBY_TIMEOUT_MS;
		let lastAdmissionCheck = 0;

		while (!stop.requested) {
			const now = Date.now();
			if (deadline && now > deadline) {
				state.set({ leaveReason: "duration_expired" });
				break;
			}

			// Admission detection every ~3s until admitted.
			if (!state.inCall && now - lastAdmissionCheck > 3_000) {
				lastAdmissionCheck = now;
				if (await probe(page, ADMISSION_JS)) {
					state.set({ inCall: true, lobbyWaiting: false, joinedAt: now });
					// Ensure captions/observer are live now that we're in.
					await enableCaptions(page);
					await page.evaluate(CAPTION_OBSERVER_JS).catch(() => {});
				} else if (now > lobbyDeadline) {
					state.set({ error: "lobby timeout — host never admitted the bot", leaveReason: "lobby_timeout" });
					break;
				} else if (await probe(page, DENIED_JS)) {
					state.set({ error: "host denied admission", leaveReason: "denied" });
					break;
				}
			}

			// Keep the observer installed across SPA transitions, then drain.
			try {
				await page.evaluate(CAPTION_OBSERVER_JS).catch(() => {});
				const queued = (await page.evaluate(DRAIN_JS)) as CaptionEntry[] | null;
				if (Array.isArray(queued)) {
					for (const e of queued) {
						if (e && typeof e === "object") {
							state.recordCaption(String(e.speaker ?? ""), String(e.text ?? ""));
						}
					}
				}
			} catch {
				if (page.isClosed()) {
					state.set({ leaveReason: "page_closed" });
					break;
				}
			}

			await Bun.sleep(TICK_MS);
		}

		// Clean leave — click "Leave call" if present.
		await page.evaluate(LEAVE_CALL_JS).catch(() => {});
		await browser.close().catch(() => {});

		state.set({
			inCall: false,
			captioning: false,
			exited: true,
			leaveReason: state.leaveReason ?? (stop.requested ? "requested" : "ended"),
		});
		return 0;
	} catch (err) {
		state.set({ error: `unhandled: ${(err as Error).message}`, exited: true });
		await browser.close().catch(() => {});
		return 1;
	}
}

process.exit(await run());

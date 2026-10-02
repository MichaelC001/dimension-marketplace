#!/usr/bin/env node
// A local "is this a bot?" page. No dependencies, no external network.
//   node bench/sites/detect.mjs --port 4778      then open http://127.0.0.1:4778/
//
// It reads, in the page, the signals that public bot-detection checks read (the Chrome-headless tells that
// sannysoft's page, BotD and the like look at). Every row says what the page SAW and whether a detector
// would FLAG it ("tell"). The verdict is derived from the value, never assumed: a fingerprint a real Chrome
// on the same machine reports is not a tell, and a row the browser cannot answer is reported as such.
//
//   GET  /                   the page; it computes every row and POSTs them to /__detect/result
//   GET  /__detect/headers   the request headers this browser sent (Accept-Language, Sec-CH-UA, User-Agent)
//   GET  /__detect/result    the rows the last visit posted (404 until one did)
//   POST /__detect/result    harness/page only
//   GET  /__detect/late      the one row that needs the driver to have acted on the page first (see `__detectLate`)
//
// `rows` is a list of { id, group, tell, value, note }. `tell: true` is a signal a detector flags.
import http from "node:http";
import { fileURLToPath } from "node:url";

/** The page. It runs once on load; `window.__detect` resolves to the rows, and `window.__detectLate()` adds the rows that need the driver to have acted first. */
export const DETECT_HTML = String.raw`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>detect</title>
<style>body{font:13px/1.4 system-ui,sans-serif;margin:16px}td,th{border:1px solid #ccc;padding:2px 6px;text-align:left}.tell{background:#fdd}.ok{background:#dfd}pre{white-space:pre-wrap}</style>
</head><body><h1>Headless detection</h1><p id="summary">running</p><table id="rows"></table><pre id="detect-json"></pre>
<script>
"use strict";
// Hooks the late rows use. They are installed before anything else on the page runs, as a site's own script would.
window.__calls = [];
for (const [proto, name] of [[Document.prototype, "getElementById"], [Document.prototype, "querySelector"], [Document.prototype, "querySelectorAll"], [Document.prototype, "elementFromPoint"], [Element.prototype, "getAttribute"], [Element.prototype, "getBoundingClientRect"], [Element.prototype, "querySelectorAll"], [Element.prototype, "closest"], [Element.prototype, "matches"], [Window.prototype, "getComputedStyle"]]) {
  const native = proto[name];
  proto[name] = function () { try { window.__calls.push(new Error().stack || ""); } catch (e) {} return native.apply(this, arguments); };
}

const rows = [];
// Rendered after every row, so a driver that reads the page text early (browser_read) still gets every row computed so far.
const render = () => {
  const tells = rows.filter((x) => x.tell);
  document.getElementById("summary").textContent = tells.length + " of " + rows.length + " signals flagged";
  document.getElementById("rows").innerHTML = rows.map((x) => "<tr class='" + (x.tell ? "tell" : "ok") + "'><td>" + x.group + "</td><td>" + x.id + "</td><td>" + (x.tell ? "FLAGGED" : "ok") + "</td><td>" + String(x.value).replace(/</g, "&lt;").slice(0, 200) + "</td></tr>").join("");
  document.getElementById("detect-json").textContent = rows.map((x) => (x.tell ? "FLAG" : "ok") + "|" + x.id + "|" + String(x.value).replace(/\s+/g, " ").slice(0, 160)).join("\n");
};
const add = (id, group, tell, value, note) => { rows.push({ id, group, tell: Boolean(tell), value: typeof value === "string" ? value : JSON.stringify(value), note: note || "" }); render(); };
const safe = (fn, fallback) => { try { return fn(); } catch (e) { return fallback === undefined ? "threw " + (e && e.name) : fallback; } };
const NATIVE = /\{\s*\[native code\]\s*\}\s*$/;
const nativeSource = (fn) => typeof fn === "function" && safe(() => NATIVE.test(Function.prototype.toString.call(fn)), false);

// True when a DevTools client has Runtime enabled in this realm. With it on, V8 serialises every console call's arguments for that client, and building an Error's preview formats its stack, which calls Error.prepareStackTrace; with it off the same call never does. (The older probe, a getter on the Error's own stack property, no longer fires in current Chrome and said "ok" for stock puppeteer.)
const runtimeEnabled = () => {
  let hit = false;
  const previous = Error.prepareStackTrace;
  try { Error.prepareStackTrace = () => { hit = true; return ""; }; console.debug(new Error()); } catch (e) {} finally { Error.prepareStackTrace = previous; }
  return hit;
};
const workerCode = "const runtimeEnabled = " + runtimeEnabled.toString() + "; let gpu = null; try { const gl = new OffscreenCanvas(1, 1).getContext('webgl'); const e = gl.getExtension('WEBGL_debug_renderer_info'); gpu = [gl.getParameter(e.UNMASKED_VENDOR_WEBGL), gl.getParameter(e.UNMASKED_RENDERER_WEBGL)]; } catch (e) {} self.postMessage({ gpu, runtime: runtimeEnabled(), userAgent: navigator.userAgent, platform: navigator.platform, webdriver: navigator.webdriver, hardwareConcurrency: navigator.hardwareConcurrency, languages: navigator.languages, brands: navigator.userAgentData ? navigator.userAgentData.brands.map(b => b.brand) : null })";
const inWorker = () => new Promise((resolve) => {
  try {
    const url = URL.createObjectURL(new Blob([workerCode], { type: "text/javascript" }));
    const worker = new Worker(url);
    const done = (value) => { worker.terminate(); URL.revokeObjectURL(url); resolve(value); };
    worker.onmessage = (e) => done(e.data);
    worker.onerror = () => done(null);
    setTimeout(() => done(null), 1500);
  } catch (e) { resolve(null); }
});

const measureFont = (family) => {
  const span = document.createElement("span");
  span.style.cssText = "position:absolute;left:-9999px;font-size:72px;font-family:" + family;
  span.textContent = "mmmmmmmmmmlliWWW@@";
  document.body.appendChild(span);
  const width = span.getBoundingClientRect().width;
  span.remove();
  return width;
};

async function run() {
  const nav = navigator;
  const ua = nav.userAgent;
  // The two slow answers (the server's view of our headers, a worker's view of navigator) start now and are added last.
  const hintsP = Promise.race([fetch("/__detect/headers", { cache: "no-store" }).then((r) => r.json()), new Promise((r) => setTimeout(() => r(null), 1500))]).catch(() => null);
  const workerP = inWorker();

  // --- automation flags -------------------------------------------------------------------------
  add("webdriver", "automation", nav.webdriver === true, String(nav.webdriver), "navigator.webdriver is true under automation");
  add("navigator-own-properties", "tamper", Object.getOwnPropertyNames(nav).length > 0, Object.getOwnPropertyNames(nav), "a real Navigator has no own properties; a patch defined on the instance shows here");

  // --- identity ---------------------------------------------------------------------------------
  add("ua-headless", "identity", /HeadlessChrome/.test(ua), ua, "the User-Agent names HeadlessChrome");
  const brands = safe(() => nav.userAgentData.brands.map((b) => b.brand), []);
  add("ua-data-headless", "identity", brands.some((b) => /Headless/i.test(b)), brands, "navigator.userAgentData.brands names HeadlessChrome");
  const platformWord = /Windows/.test(ua) ? "Win" : /Mac OS X/.test(ua) ? "Mac" : /Linux/.test(ua) ? "Linux" : "?";
  add("platform-consistent", "identity", !String(nav.platform).startsWith(platformWord), nav.platform + " / " + ua.slice(ua.indexOf("(") + 1, ua.indexOf(")")), "navigator.platform disagrees with the platform in the User-Agent");

  // --- the Chrome object ------------------------------------------------------------------------
  add("chrome-object", "chrome", typeof window.chrome === "undefined", typeof window.chrome, "real Chrome defines window.chrome");
  const chromeParts = ["app", "csi", "loadTimes"].filter((k) => !(window.chrome && k in window.chrome));
  add("chrome-parts", "chrome", typeof window.chrome !== "undefined" && chromeParts.length > 0, chromeParts.length ? "missing " + chromeParts.join(",") : "app, csi, loadTimes present", "window.chrome.app / csi / loadTimes");
  add("chrome-runtime", "chrome", false, safe(() => typeof window.chrome.runtime), "information only: a real Chrome page has chrome.runtime only where an extension exposes it");

  // --- plugins and mime types -------------------------------------------------------------------
  const plugins = Array.from(nav.plugins || [], (p) => p.name);
  add("plugins-count", "plugins", plugins.length === 0, plugins, "navigator.plugins is empty (Chrome lists its PDF viewers)");
  add("mimetypes-count", "plugins", (nav.mimeTypes || []).length === 0, (nav.mimeTypes || []).length, "navigator.mimeTypes is empty");
  add("plugins-integrity", "tamper", !(nav.plugins instanceof PluginArray && Object.prototype.toString.call(nav.plugins) === "[object PluginArray]" && (nav.plugins.length === 0 || nav.plugins[0] instanceof Plugin)), safe(() => Object.prototype.toString.call(nav.plugins)), "plugins is not a genuine PluginArray of Plugin objects");

  // --- languages and locale ---------------------------------------------------------------------
  add("languages-empty", "locale", !nav.languages || nav.languages.length === 0, nav.languages, "navigator.languages is empty");
  add("language-first", "locale", !nav.languages || nav.languages[0] !== nav.language, [nav.language, nav.languages], "navigator.language is not the first of navigator.languages");
  const intlLocale = Intl.DateTimeFormat().resolvedOptions().locale;
  add("locale-intl", "locale", intlLocale.split("-")[0] !== String(nav.language).split("-")[0], [intlLocale, nav.language], "Intl's locale and navigator.language name different languages");

  // --- permissions ------------------------------------------------------------------------------
  const status = await navigator.permissions.query({ name: "notifications" }).then((s) => s.state, () => "threw");
  const asState = { default: "prompt", denied: "denied", granted: "granted" }[window.Notification && Notification.permission];
  add("notification-permission", "permissions", asState !== status, [window.Notification && Notification.permission, status], "Notification.permission and permissions.query must agree (default = prompt); 'denied' beside 'prompt' is the classic headless contradiction");

  // --- WebGL ------------------------------------------------------------------------------------
  const gl = safe(() => document.createElement("canvas").getContext("webgl"), null);
  if (!gl) add("webgl-available", "webgl", true, "no WebGL context", "WebGL is unavailable");
  else {
    const ext = gl.getExtension("WEBGL_debug_renderer_info");
    const vendor = ext ? gl.getParameter(ext.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR);
    const renderer = ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
    add("webgl-renderer", "webgl", /swiftshader|llvmpipe|lavapipe|software|mesa offscreen|google inc\. \(google\)/i.test(vendor + " " + renderer), [vendor, renderer], "a software renderer (SwiftShader, llvmpipe) is the headless-server tell");
  }

  // --- hardware ---------------------------------------------------------------------------------
  add("hardware-concurrency", "hardware", !(nav.hardwareConcurrency >= 2), nav.hardwareConcurrency, "fewer than two logical cores");
  add("device-memory", "hardware", window.isSecureContext && typeof nav.deviceMemory === "undefined", nav.deviceMemory, "navigator.deviceMemory is missing on a secure page");

  // --- screen and window ------------------------------------------------------------------------
  add("outer-window", "screen", window.outerWidth === 0 || window.outerHeight === 0, [window.outerWidth, window.outerHeight], "the window reports a zero outer size");
  add("outer-equals-inner", "screen", window.outerHeight === window.innerHeight && window.outerWidth === window.innerWidth, [window.outerWidth, window.outerHeight, window.innerWidth, window.innerHeight], "outer size equals inner size: a window with no browser chrome");
  add("outer-smaller-than-inner", "screen", window.outerWidth < window.innerWidth || window.outerHeight < window.innerHeight, [window.outerWidth, window.outerHeight, window.innerWidth, window.innerHeight], "the window is smaller than the page inside it");
  add("viewport-larger-than-screen", "screen", window.innerWidth > screen.width || window.innerHeight > screen.height, [window.innerWidth, window.innerHeight, screen.width, screen.height], "the page is larger than the screen it is on");
  const landscape = screen.width >= screen.height;
  add("screen-orientation", "screen", Boolean(screen.orientation) && screen.orientation.type.startsWith("landscape") !== landscape, [screen.orientation && screen.orientation.type, screen.width, screen.height], "screen.orientation disagrees with the screen's own shape (a 1280x800 headless page reports portrait-primary)");
  add("window-fits-screen", "screen", window.outerWidth > screen.width || window.outerHeight > screen.height, [window.outerWidth, window.outerHeight, screen.width, screen.height], "the window is larger than the screen");
  add("screen-default", "screen", (screen.width === 800 && screen.height === 600) || screen.width === 0, [screen.width, screen.height], "the 800x600 default screen");
  add("color-depth", "screen", ![24, 30, 32, 48].includes(screen.colorDepth), screen.colorDepth, "an unusual colour depth");

  // --- activity ---------------------------------------------------------------------------------
  add("page-visible", "activity", document.hidden || document.visibilityState !== "visible", [document.hidden, document.visibilityState], "the page reports itself hidden");
  add("page-focus", "activity", !document.hasFocus(), document.hasFocus(), "document.hasFocus() is false");

  // --- hairline (Modernizr) ---------------------------------------------------------------------
  const style = document.createElement("style");
  style.textContent = "#modernizr{border:.5px solid transparent}";
  document.head.appendChild(style);
  const probe = document.createElement("div");
  probe.id = "modernizr";
  document.body.appendChild(probe);
  const hairline = probe.offsetHeight;
  probe.remove(); style.remove();
  add("hairline", "hairline", hairline === 0, hairline, "Modernizr's hairline test measures 0 (headless Chrome's old answer)");

  // --- iframe -----------------------------------------------------------------------------------
  const frame = document.createElement("iframe");
  frame.srcdoc = "<p>frame</p>";
  document.body.appendChild(frame);
  const fw = frame.contentWindow;
  add("iframe-chrome", "iframe", typeof window.chrome !== "undefined" && typeof fw.chrome === "undefined", safe(() => typeof fw.chrome), "a srcdoc iframe lacks window.chrome while the page has it");
  add("iframe-webdriver", "iframe", safe(() => fw.navigator.webdriver === true, false), safe(() => String(fw.navigator.webdriver)), "an iframe's navigator.webdriver is true");
  add("iframe-ua", "iframe", safe(() => /HeadlessChrome/.test(fw.navigator.userAgent), true), safe(() => fw.navigator.userAgent), "an iframe's User-Agent names HeadlessChrome");
  add("iframe-window-proxy", "iframe", safe(() => !(fw.self === fw.window && fw.frameElement === frame), true), "self/frameElement", "an iframe's window is not the genuine one");
  frame.remove();

  // --- codecs -----------------------------------------------------------------------------------
  const v = document.createElement("video"), a = document.createElement("audio");
  const h264 = v.canPlayType('video/mp4; codecs="avc1.42E01E"');
  const aac = a.canPlayType('audio/mp4; codecs="mp4a.40.2"');
  add("codec-h264", "codecs", h264 === "", h264 || "(empty)", "no H.264: a Chromium build without proprietary codecs");
  add("codec-aac", "codecs", aac === "", aac || "(empty)", "no AAC: a Chromium build without proprietary codecs");

  // --- audio ------------------------------------------------------------------------------------
  const audio = safe(() => { const ctx = new AudioContext(); const r = { baseLatency: ctx.baseLatency, outputLatency: ctx.outputLatency, sampleRate: ctx.sampleRate, state: ctx.state }; ctx.close(); return r; }, null);
  add("audio-context", "audio", audio === null || (audio.baseLatency === 0 && audio.outputLatency === 0), audio, "no AudioContext, or an audio device that reports zero latency (no device)");

  // --- fonts ------------------------------------------------------------------------------------
  const common = ["Arial", "Courier New", "Times New Roman", "Verdana", "Georgia", "Tahoma", "Segoe UI", "Consolas", "Calibri", "Cambria", "Comic Sans MS", "Trebuchet MS", "Impact", "Lucida Console", "Palatino Linotype", "Helvetica", "Menlo", "DejaVu Sans", "Liberation Sans"];
  const generic = ["monospace", "sans-serif", "serif"];
  const base = generic.map(measureFont);
  const present = common.filter((f) => generic.some((g, i) => measureFont("'" + f + "'," + g) !== base[i]));
  add("fonts-installed", "fonts", present.length < 3, present, "fewer than three of nineteen common fonts are installed (a bare container)");

  // --- tamper: are the Navigator accessors genuine? --------------------------------------------
  const accessors = ["webdriver", "languages", "plugins", "hardwareConcurrency", "platform", "userAgent"];
  const wrongReceiver = accessors.filter((k) => {
    const d = Object.getOwnPropertyDescriptor(Navigator.prototype, k);
    if (!d || !d.get) return false;
    try { d.get.call({}); return true; } catch (e) { return !(e instanceof TypeError); }
  });
  add("accessor-receiver", "tamper", wrongReceiver.length > 0, wrongReceiver.length ? wrongReceiver : "all throw on a foreign receiver", "a real accessor throws 'Illegal invocation' for a receiver that is not a Navigator; a plain override answers anyway");
  const patchedNative = [
    ["permissions.query", navigator.permissions && navigator.permissions.query], ["getContext", HTMLCanvasElement.prototype.getContext],
    ["WebGL getParameter", window.WebGLRenderingContext && WebGLRenderingContext.prototype.getParameter], ["canPlayType", HTMLMediaElement.prototype.canPlayType],
    ["Function.prototype.toString", Function.prototype.toString], ["Navigator.plugins getter", Object.getOwnPropertyDescriptor(Navigator.prototype, "plugins").get],
    ["Navigator.webdriver getter", (Object.getOwnPropertyDescriptor(Navigator.prototype, "webdriver") || {}).get], ["iframe contentWindow getter", Object.getOwnPropertyDescriptor(HTMLIFrameElement.prototype, "contentWindow").get],
  ].filter(([, fn]) => fn !== undefined).filter(([, fn]) => !nativeSource(fn)).map(([n]) => n);
  add("native-source", "tamper", patchedNative.length > 0, patchedNative.length ? patchedNative : "all report [native code]", "an API whose source is not '[native code]' has been replaced");
  // The page's own hooks above are not counted: they are the detector's.

  // --- what the server and a worker saw ---------------------------------------------------------
  const hints = await hintsP;
  add("ch-ua-header-headless", "identity", hints !== null && /Headless/i.test(hints["sec-ch-ua"] || ""), hints ? hints["sec-ch-ua"] || "(none sent)" : "n/a", "the Sec-CH-UA request header names HeadlessChrome");
  const header = hints ? String(hints["accept-language"] || "") : null;
  add("accept-language", "locale", header !== null && header.split(",")[0].split(";")[0].trim() !== nav.languages[0], [header, nav.languages], "the Accept-Language header disagrees with navigator.languages (or is missing)");
  const worker = await workerP;
  add("worker-ua-headless", "worker", worker === null || /HeadlessChrome/.test(worker.userAgent), worker ? worker.userAgent : "no worker", "a dedicated worker's navigator.userAgent names HeadlessChrome");
  add("worker-webdriver", "worker", worker !== null && worker.webdriver === true, worker ? String(worker.webdriver) : "no worker", "a worker's navigator.webdriver is true");
  add("webgl-worker-renderer", "worker", false, worker ? worker.gpu : "no worker", "information only: the renderer a worker's OffscreenCanvas reports (a page-script mask does not reach workers)");
  add("worker-matches-page", "worker", worker !== null && (worker.userAgent !== ua || worker.platform !== nav.platform || worker.hardwareConcurrency !== nav.hardwareConcurrency || JSON.stringify(worker.languages) !== JSON.stringify(nav.languages)), worker ? { ua: worker.userAgent === ua, platform: worker.platform === nav.platform, cores: worker.hardwareConcurrency === nav.hardwareConcurrency, languages: JSON.stringify(worker.languages) === JSON.stringify(nav.languages) } : "no worker", "a patched page that leaves its workers unpatched disagrees with itself");
  add("worker-runtime-enabled", "driver", worker !== null && worker.runtime === true, worker ? String(worker.runtime) : "no worker", "a DevTools client has Runtime enabled in a dedicated worker (puppeteer does it for every worker it attaches)");


  // --- the driver ------------------------------------------------------------------------------
  // Runtime.enable is the most-probed CDP side effect: puppeteer sends it on every page, every out-of-process frame and every worker.
  const runtime = runtimeEnabled();
  add("cdp-runtime-enabled", "driver", runtime, runtime, "a DevTools client has Runtime enabled in this page (true under stock puppeteer)");
  return rows;
}

// Rows that need the driver to have acted on the page first (it called getElementById / getAttribute from a script it injected).
window.__detectLate = () => {
  const marked = window.__calls.filter((s) => /pptr:|__puppeteer_evaluation_script__|puppeteer/i.test(s));
  return { id: "driver-sourceurl", group: "driver", tell: marked.length > 0, value: marked.length ? marked[0].split("\n").filter((l) => /pptr:|puppeteer/i.test(l))[0].trim() : window.__calls.length + " driver calls, none named the driver", note: "a script the driver injected is named in the stack of the page API it called" };
};

// The page reports the late row every half second, so a driver that cannot run script in the page (a saved profile) is measured the same way.
setInterval(() => { fetch("/__detect/late", { method: "POST", body: JSON.stringify(window.__detectLate()) }).catch(() => undefined); }, 500);

window.__detect = run().then(async (r) => {
  document.getElementById("summary").textContent += " (done)";
  await fetch("/__detect/result", { method: "POST", body: JSON.stringify(r) }).catch(() => undefined);
  return r;
});
</script></body></html>`;

/** The detection server. `rows()` is what the last visit posted; `headers()` is the last request to /__detect/headers. */
export function createDetectServer({ port = 0 } = {}) {
  let posted = null;
  let late = null;
  let lates = 0;
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname === "/__detect/headers") {
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store", "accept-ch": "sec-ch-ua" });
      res.end(JSON.stringify(req.headers));
      return;
    }
    if (url.pathname === "/__detect/result") {
      if (req.method === "POST") {
        const chunks = [];
        req.on("data", (c) => chunks.push(c));
        req.on("end", () => {
          try { posted = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { posted = null; }
          res.writeHead(204).end();
        });
        return;
      }
      if (posted === null) { res.writeHead(404).end(); return; }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(posted));
      return;
    }
    if (url.pathname === "/__detect/late") {
      if (req.method === "POST") {
        const chunks = [];
        req.on("data", (c) => chunks.push(c));
        req.on("end", () => {
          try { late = JSON.parse(Buffer.concat(chunks).toString("utf8")); lates += 1; } catch { late = null; }
          res.writeHead(204).end();
        });
        return;
      }
      res.writeHead(late === null ? 404 : 200, { "content-type": "application/json" });
      res.end(JSON.stringify(late));
      return;
    }
    if (url.pathname === "/") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      res.end(DETECT_HTML);
      return;
    }
    res.writeHead(404).end();
  });
  return new Promise((resolve) => {
    server.listen(port, "127.0.0.1", () => {
      const { port: bound } = server.address();
      resolve({
        url: `http://127.0.0.1:${bound}/`,
        rows: () => posted,
        late: () => late,
        /** How many times the page has reported the late row; a post that began after a driver action is proof the row saw it. */
        lates: () => lates,
        reset: () => { posted = null; late = null; lates = 0; },
        stop: () => new Promise((done) => { server.close(() => done()); server.closeAllConnections?.(); }),
      });
    });
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const at = process.argv.indexOf("--port");
  const { url } = await createDetectServer({ port: at > 0 ? Number(process.argv[at + 1]) : 4778 });
  console.log(`detection page: ${url}`);
}

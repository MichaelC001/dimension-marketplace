// src/marks.ts
var MARKS = [
  {
    id: "x",
    label: "X",
    hex: "#000000",
    fill: "theme",
    path: "M14.234 10.162 22.977 0h-2.072l-7.591 8.824L7.251 0H.258l9.168 13.343L.258 24H2.33l8.016-9.318L16.749 24h6.993zm-2.837 3.299-.929-1.329L3.076 1.56h3.182l5.965 8.532.929 1.329 7.754 11.09h-3.182z"
  },
  {
    id: "reddit",
    label: "Reddit",
    hex: "#FF4500",
    fill: "#FF4500",
    backing: '<circle cx="12" cy="12" r="11.4" fill="#FFFFFF"/>',
    path: "M12 0C5.373 0 0 5.373 0 12c0 3.314 1.343 6.314 3.515 8.485l-2.286 2.286C.775 23.225 1.097 24 1.738 24H12c6.627 0 12-5.373 12-12S18.627 0 12 0Zm4.388 3.199c1.104 0 1.999.895 1.999 1.999 0 1.105-.895 2-1.999 2-.946 0-1.739-.657-1.947-1.539v.002c-1.147.162-2.032 1.15-2.032 2.341v.007c1.776.067 3.4.567 4.686 1.363.473-.363 1.064-.58 1.707-.58 1.547 0 2.802 1.254 2.802 2.802 0 1.117-.655 2.081-1.601 2.531-.088 3.256-3.637 5.876-7.997 5.876-4.361 0-7.905-2.617-7.998-5.87-.954-.447-1.614-1.415-1.614-2.538 0-1.548 1.255-2.802 2.803-2.802.645 0 1.239.218 1.712.585 1.275-.79 2.881-1.291 4.64-1.365v-.01c0-1.663 1.263-3.034 2.88-3.207.188-.911.993-1.595 1.959-1.595Zm-8.085 8.376c-.784 0-1.459.78-1.506 1.797-.047 1.016.64 1.429 1.426 1.429.786 0 1.371-.369 1.418-1.385.047-1.017-.553-1.841-1.338-1.841Zm7.406 0c-.786 0-1.385.824-1.338 1.841.047 1.017.634 1.385 1.418 1.385.785 0 1.473-.413 1.426-1.429-.046-1.017-.721-1.797-1.506-1.797Zm-3.703 4.013c-.974 0-1.907.048-2.77.135-.147.015-.241.168-.183.305.483 1.154 1.622 1.964 2.953 1.964 1.33 0 2.47-.81 2.953-1.964.057-.137-.037-.29-.184-.305-.863-.087-1.795-.135-2.769-.135Z"
  },
  {
    id: "youtube",
    label: "YouTube",
    hex: "#FF0000",
    fill: "#FF0000",
    backing: '<rect x="9" y="8" width="7.5" height="8" fill="#FFFFFF"/>',
    path: "M23.498 6.186a3.016 3.016 0 0 0-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 0 0 .502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 0 0 2.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 0 0 2.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814zM9.545 15.568V8.432L15.818 12l-6.273 3.568z"
  },
  {
    id: "discord",
    label: "Discord",
    hex: "#5865F2",
    fill: "#5865F2",
    path: "M20.317 4.3698a19.7913 19.7913 0 00-4.8851-1.5152.0741.0741 0 00-.0785.0371c-.211.3753-.4447.8648-.6083 1.2495-1.8447-.2762-3.68-.2762-5.4868 0-.1636-.3933-.4058-.8742-.6177-1.2495a.077.077 0 00-.0785-.037 19.7363 19.7363 0 00-4.8852 1.515.0699.0699 0 00-.0321.0277C.5334 9.0458-.319 13.5799.0992 18.0578a.0824.0824 0 00.0312.0561c2.0528 1.5076 4.0413 2.4228 5.9929 3.0294a.0777.0777 0 00.0842-.0276c.4616-.6304.8731-1.2952 1.226-1.9942a.076.076 0 00-.0416-.1057c-.6528-.2476-1.2743-.5495-1.8722-.8923a.077.077 0 01-.0076-.1277c.1258-.0943.2517-.1923.3718-.2914a.0743.0743 0 01.0776-.0105c3.9278 1.7933 8.18 1.7933 12.0614 0a.0739.0739 0 01.0785.0095c.1202.099.246.1981.3728.2924a.077.077 0 01-.0066.1276 12.2986 12.2986 0 01-1.873.8914.0766.0766 0 00-.0407.1067c.3604.698.7719 1.3628 1.225 1.9932a.076.076 0 00.0842.0286c1.961-.6067 3.9495-1.5219 6.0023-3.0294a.077.077 0 00.0313-.0552c.5004-5.177-.8382-9.6739-3.5485-13.6604a.061.061 0 00-.0312-.0286zM8.02 15.3312c-1.1825 0-2.1569-1.0857-2.1569-2.419 0-1.3332.9555-2.4189 2.157-2.4189 1.2108 0 2.1757 1.0952 2.1568 2.419 0 1.3332-.9555 2.4189-2.1569 2.4189zm7.9748 0c-1.1825 0-2.1569-1.0857-2.1569-2.419 0-1.3332.9554-2.4189 2.1569-2.4189 1.2108 0 2.1757 1.0952 2.1568 2.419 0 1.3332-.946 2.4189-2.1568 2.4189Z"
  }
];

// src/avatar.ts
var PROTOCOL_VERSION = 5;
function isObject(value) {
  return typeof value === "object" && value !== null;
}
function isFrame(data) {
  return isObject(data) && data.__fraymPack === true && typeof data.v === "number" && data.v <= PROTOCOL_VERSION && typeof data.kind === "string";
}
function asTheme(value) {
  if (!isObject(value) || typeof value.tokens !== "string")
    return;
  return value.mode === "dark" || value.mode === "light" ? { mode: value.mode } : undefined;
}
function asPresence(value) {
  if (!isObject(value))
    return;
  const { state, mode, energy, emotion, motion, gateOpen, fpsCap } = value;
  if (state !== "idle" && state !== "thinking" && state !== "typing")
    return;
  if (typeof mode !== "string" || typeof energy !== "number" || typeof emotion !== "string")
    return;
  if (motion !== undefined && typeof motion !== "string")
    return;
  if (gateOpen !== undefined && typeof gateOpen !== "boolean")
    return;
  if (fpsCap !== undefined && typeof fpsCap !== "number")
    return;
  return { state, mode, energy, emotion, motion, gateOpen, fpsCap };
}
function post(frame) {
  window.parent.postMessage({ __fraymPack: true, v: PROTOCOL_VERSION, ...frame }, "*");
}
var CSS = `
#fraym-pack-root{display:grid;place-items:center;overflow:hidden}
.bm{--bm-amp:.04;--bm-bob:2%;--bm-orbit:1.8s;position:relative;width:min(100vw,100vh);height:min(100vw,100vh);color:#fff}
.bm[data-theme="light"]{color:#000}
.bm-halo,.bm-ring,.bm-sweep{position:absolute;border-radius:50%;opacity:0;pointer-events:none;transition:opacity .45s ease}
.bm-halo{inset:2%;background:radial-gradient(circle,color-mix(in srgb,var(--bm-tint) 55%,transparent) 0%,color-mix(in srgb,var(--bm-tint) 18%,transparent) 45%,transparent 70%)}
.bm-ring{inset:5%;border:2px solid transparent;border-top-color:var(--bm-tint);border-right-color:color-mix(in srgb,var(--bm-tint) 35%,transparent)}
.bm-sweep{inset:5%;background:conic-gradient(from 0deg,transparent 0 70%,color-mix(in srgb,var(--bm-tint) 45%,transparent) 100%);-webkit-mask:radial-gradient(circle,transparent 60%,#000 61%);mask:radial-gradient(circle,transparent 60%,#000 61%)}
.bm-motion,.bm-pop{position:absolute;inset:0}
.bm-mark{position:absolute;inset:14%;width:72%;height:72%;display:block}

/* Static cue (costs nothing): the halo shows whenever the session is busy. */
.bm:not([data-state="idle"]) .bm-halo{opacity:.55}
.bm[data-state="typing"] .bm-halo{opacity:.8}

/* Everything below animates, and ONLY while data-live="1". */
.bm[data-live="1"][data-state="thinking"] .bm-motion{animation:bm-breathe 3.2s ease-in-out infinite}
.bm[data-live="1"][data-state="typing"] .bm-motion{animation:bm-bob .9s ease-in-out infinite}
.bm[data-live="1"][data-state="thinking"] .bm-halo{animation:bm-glow 3.2s ease-in-out infinite}
.bm[data-live="1"]:not([data-state="idle"]):is([data-mode="run"],[data-mode="edit"]) .bm-ring{opacity:1;animation:bm-orbit var(--bm-orbit) linear infinite}
.bm[data-live="1"]:not([data-state="idle"]):is([data-mode="search"],[data-mode="read"]) .bm-sweep{opacity:1;animation:bm-orbit calc(var(--bm-orbit) * 1.3) linear infinite}
.bm[data-live="1"]:not([data-state="idle"])[data-pop="1"] .bm-pop{animation:bm-pop .52s cubic-bezier(.3,1.6,.5,1) 1}

@keyframes bm-breathe{0%,100%{transform:scale(1)}50%{transform:scale(calc(1 + var(--bm-amp)))}}
@keyframes bm-bob{0%,100%{transform:translateY(0) scale(1)}50%{transform:translateY(calc(-1 * var(--bm-bob))) scale(calc(1 + var(--bm-amp) / 2))}}
@keyframes bm-glow{0%,100%{opacity:.35}50%{opacity:.75}}
@keyframes bm-orbit{to{transform:rotate(1turn)}}
@keyframes bm-pop{0%,100%{transform:scale(1)}40%{transform:scale(1.1)}}

/* Reduced motion: no animation AND no transition, whatever the host says. */
@media (prefers-reduced-motion: reduce){
	.bm *{animation:none!important;transition:none!important}
}
`;
var SVG_NS = "http://www.w3.org/2000/svg";
function markSvg(mark) {
  const fill = mark.fill === "theme" ? "currentColor" : mark.fill;
  return `<svg class="bm-mark" xmlns="${SVG_NS}" viewBox="0 0 24 24" preserveAspectRatio="xMidYMid meet" role="img" aria-label="${mark.label}">` + `<title>${mark.label}</title>${mark.backing ?? ""}<path fill="${fill}" d="${mark.path}"/></svg>`;
}
var POP_EMOTIONS = { pleased: true, proud: true, playful: true };
function mount(root, mark) {
  const style = document.createElement("style");
  style.textContent = CSS;
  document.head.append(style);
  const stage = document.createElement("div");
  stage.className = "bm";
  stage.dataset.mark = mark.id;
  stage.innerHTML = `<div class="bm-halo"></div><div class="bm-sweep"></div><div class="bm-ring"></div>` + `<div class="bm-motion"><div class="bm-pop">${markSvg(mark)}</div></div>`;
  root.replaceChildren(stage);
  const pop = stage.querySelector(".bm-pop");
  pop?.addEventListener("animationend", () => delete stage.dataset.pop);
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  let lastPresence;
  let lastTheme;
  let lastEmotion = "";
  const paint = (presence, theme) => {
    lastPresence = presence;
    lastTheme = theme;
    const mode = theme?.mode ?? "dark";
    stage.dataset.theme = mode;
    if (theme)
      document.documentElement.style.colorScheme = mode;
    stage.style.setProperty("--bm-tint", mark.fill === "theme" ? mode === "dark" ? "#FFFFFF" : "#000000" : mark.hex);
    const state = presence?.state ?? "idle";
    stage.dataset.state = state;
    stage.dataset.mode = presence?.mode ?? "";
    const motion = presence?.motion;
    const live = presence !== undefined && motion !== "off" && motion !== "still" && presence.gateOpen !== false && !reducedMotion.matches;
    stage.dataset.live = live ? "1" : "0";
    const energy = Number.isFinite(presence?.energy) ? Math.min(1, Math.max(0, presence?.energy ?? 0)) : 0;
    const damp = motion === "idle" ? 0.5 : 1;
    stage.style.setProperty("--bm-amp", ((0.025 + 0.045 * energy) * damp).toFixed(4));
    stage.style.setProperty("--bm-bob", `${((1 + 2.5 * energy) * damp).toFixed(2)}%`);
    stage.style.setProperty("--bm-orbit", `${(2.4 - 1.2 * energy).toFixed(2)}s`);
    const emotion = presence?.emotion ?? "";
    if (live && state !== "idle" && emotion !== lastEmotion && POP_EMOTIONS[emotion] === true) {
      delete stage.dataset.pop;
      stage.offsetWidth;
      stage.dataset.pop = "1";
    }
    lastEmotion = emotion;
  };
  reducedMotion.addEventListener("change", () => paint(lastPresence, lastTheme));
  return paint;
}
function boot() {
  const root = document.getElementById("fraym-pack-root");
  const requested = new URL(import.meta.url).searchParams.get("avatar");
  const mark = requested === null ? MARKS[0] : MARKS.find((m) => m.id === requested);
  if (!root) {
    post({ kind: "error", message: "brand-marks: #fraym-pack-root is missing from the host document" });
    return;
  }
  if (!mark) {
    post({
      kind: "error",
      message: `brand-marks: unknown avatar "${requested}" (this bundle ships ${MARKS.map((m) => m.id).join(", ")})`
    });
    return;
  }
  const paint = mount(root, mark);
  let presence;
  let theme;
  paint(presence, theme);
  window.addEventListener("message", (event) => {
    if (event.source !== window.parent || !isFrame(event.data))
      return;
    const frame = event.data;
    if (frame.kind === "init") {
      const channels = isObject(frame.channels) ? frame.channels : {};
      theme = asTheme(channels.theme) ?? theme;
      presence = asPresence(channels.presence) ?? presence;
    } else if (frame.kind === "state") {
      if (frame.channel === "theme")
        theme = asTheme(frame.value) ?? theme;
      else if (frame.channel === "presence")
        presence = asPresence(frame.value) ?? presence;
      else
        return;
    } else {
      return;
    }
    paint(presence, theme);
  });
  post({ kind: "ready", subscribe: ["theme", "presence"] });
}
boot();

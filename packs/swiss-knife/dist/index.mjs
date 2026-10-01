// src/present.ts
import { constants } from "node:fs";
import { open, realpath, stat } from "node:fs/promises";
import { basename, resolve } from "node:path";

// ../../../fraym/packages/driver/src/classify-file.ts
var BINARY = { kind: "binary", mime: "application/octet-stream" };
var TEXT = { kind: "text", mime: "text/plain" };
var OOXML = "application/vnd.openxmlformats-officedocument";
var BY_EXTENSION = {
  png: { kind: "image", mime: "image/png" },
  jpg: { kind: "image", mime: "image/jpeg" },
  jpeg: { kind: "image", mime: "image/jpeg" },
  gif: { kind: "image", mime: "image/gif" },
  webp: { kind: "image", mime: "image/webp" },
  avif: { kind: "image", mime: "image/avif" },
  bmp: { kind: "image", mime: "image/bmp" },
  svg: { kind: "image", mime: "image/svg+xml" },
  ico: { kind: "image", mime: "image/x-icon" },
  pdf: { kind: "pdf", mime: "application/pdf" },
  docx: { kind: "docx", mime: `${OOXML}.wordprocessingml.document` },
  pptx: { kind: "pptx", mime: `${OOXML}.presentationml.presentation` },
  xlsx: { kind: "xlsx", mime: `${OOXML}.spreadsheetml.sheet` },
  xlsm: { kind: "xlsx", mime: "application/vnd.ms-excel.sheet.macroenabled.12" },
  md: { kind: "markdown", mime: "text/markdown" },
  markdown: { kind: "markdown", mime: "text/markdown" },
  mdx: { kind: "markdown", mime: "text/markdown" },
  html: { kind: "html", mime: "text/html" },
  htm: { kind: "html", mime: "text/html" },
  xhtml: { kind: "html", mime: "application/xhtml+xml" },
  txt: { kind: "text", mime: "text/plain" },
  log: { kind: "text", mime: "text/plain" },
  csv: { kind: "text", mime: "text/csv" },
  tsv: { kind: "text", mime: "text/tab-separated-values" },
  json: { kind: "code", mime: "application/json" },
  yaml: { kind: "code", mime: "application/yaml" },
  yml: { kind: "code", mime: "application/yaml" },
  toml: { kind: "code", mime: "application/toml" },
  xml: { kind: "code", mime: "application/xml" },
  css: { kind: "code", mime: "text/css" },
  js: { kind: "code", mime: "text/javascript" },
  mjs: { kind: "code", mime: "text/javascript" },
  ts: { kind: "code", mime: "text/typescript" },
  tsx: { kind: "code", mime: "text/typescript" },
  jsx: { kind: "code", mime: "text/javascript" },
  py: { kind: "code", mime: "text/x-python" },
  rs: { kind: "code", mime: "text/x-rust" },
  go: { kind: "code", mime: "text/x-go" },
  java: { kind: "code", mime: "text/x-java" },
  c: { kind: "code", mime: "text/x-c" },
  h: { kind: "code", mime: "text/x-c" },
  cpp: { kind: "code", mime: "text/x-c++" },
  sh: { kind: "code", mime: "text/x-shellscript" },
  sql: { kind: "code", mime: "application/sql" },
  mp3: { kind: "audio", mime: "audio/mpeg" },
  wav: { kind: "audio", mime: "audio/wav" },
  ogg: { kind: "audio", mime: "audio/ogg" },
  flac: { kind: "audio", mime: "audio/flac" },
  m4a: { kind: "audio", mime: "audio/mp4" },
  m4b: { kind: "audio", mime: "audio/mp4" },
  opus: { kind: "audio", mime: "audio/ogg" },
  oga: { kind: "audio", mime: "audio/ogg" },
  aac: { kind: "audio", mime: "audio/aac" },
  weba: { kind: "audio", mime: "audio/webm" },
  mka: { kind: "audio", mime: "audio/x-matroska" },
  mp4: { kind: "video", mime: "video/mp4" },
  m4v: { kind: "video", mime: "video/x-m4v" },
  webm: { kind: "video", mime: "video/webm" },
  ogv: { kind: "video", mime: "video/ogg" },
  mov: { kind: "video", mime: "video/quicktime" },
  mkv: { kind: "video", mime: "video/x-matroska" },
  zip: { kind: "archive", mime: "application/zip" },
  tar: { kind: "archive", mime: "application/x-tar" },
  gz: { kind: "archive", mime: "application/gzip" },
  tgz: { kind: "archive", mime: "application/gzip" },
  "7z": { kind: "archive", mime: "application/x-7z-compressed" },
  rar: { kind: "archive", mime: "application/vnd.rar" }
};
function lookup(extension) {
  return Object.hasOwn(BY_EXTENSION, extension) ? BY_EXTENSION[extension] : void 0;
}
function startsWith(head, bytes, at = 0) {
  if (head.length < at + bytes.length) return false;
  for (let index = 0; index < bytes.length; index++) if (head[at + index] !== bytes[index]) return false;
  return true;
}
function byMagic(head) {
  if (startsWith(head, [137, 80, 78, 71, 13, 10, 26, 10])) return lookup("png");
  if (startsWith(head, [255, 216, 255])) return lookup("jpg");
  if (startsWith(head, [71, 73, 70, 56])) return lookup("gif");
  if (startsWith(head, [82, 73, 70, 70]) && startsWith(head, [87, 69, 66, 80], 8)) {
    return lookup("webp");
  }
  if (startsWith(head, [37, 80, 68, 70, 45])) return lookup("pdf");
  return void 0;
}
function looksLikeText(head) {
  if (head.length === 0) return false;
  for (const byte of head) {
    if (byte === 0) return false;
    if (byte < 9 || byte > 13 && byte < 32 && byte !== 27) return false;
  }
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(head, { stream: true });
    return true;
  } catch {
    return false;
  }
}
function extensionOf(name) {
  const base = name.split(/[\\/]/).pop() ?? name;
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : "";
}
function classifyFile(name, head) {
  if (head !== void 0) {
    const magic = byMagic(head);
    if (magic !== void 0) return magic;
  }
  const named = lookup(extensionOf(name));
  if (named !== void 0) return named;
  if (head !== void 0 && looksLikeText(head)) return TEXT;
  return BINARY;
}

// ../../../fraym/packages/driver/src/presentation.ts
var PRESENTED_KINDS = [
  "image",
  "pdf",
  "docx",
  "pptx",
  "xlsx",
  "markdown",
  "html",
  "text",
  "code",
  "audio",
  "video",
  "archive",
  "binary"
];
var MAX_PRESENTED_ITEMS = 12;
var KIND_SET = new Set(PRESENTED_KINDS);
var PRESENTED_KIND_LABELS = {
  image: "Image",
  pdf: "PDF",
  docx: "Word",
  pptx: "PowerPoint",
  xlsx: "Excel",
  markdown: "Markdown",
  html: "HTML",
  text: "Text",
  code: "Code",
  audio: "Audio",
  video: "Video",
  archive: "Archive",
  binary: "File"
};
var SIZE_UNITS = ["B", "KB", "MB", "GB", "TB"];
function formatByteSize(bytes) {
  let value = Number.isFinite(bytes) && bytes > 0 ? bytes : 0;
  let unit = 0;
  while (unit < SIZE_UNITS.length - 1 && Math.round(value) >= 1024) {
    value /= 1024;
    unit++;
  }
  const shown = unit > 0 && value < 10 ? Math.round(value * 10) / 10 : Math.round(value);
  return `${shown} ${SIZE_UNITS[unit]}`;
}

// ../../../fraym/packages/driver/src/types.ts
var TERMINAL_CONTINUATION_REASONS = Object.assign(
  /* @__PURE__ */ Object.create(null),
  { handoff: true, new: true, plan: true, drop: true }
);

// ../../../fraym/packages/driver/src/theme.ts
var THEME_TOKEN_CHANNELS = {
  "--fr-accent": "color",
  "--fr-accent-2": "color",
  "--fr-accent-dim": "color",
  "--fr-accent-line": "color",
  "--fr-accent-ink": "color",
  "--fr-accent-text": "color",
  "--fr-accent-grad": "paint",
  "--fr-accent-grad-hover": "paint",
  "--fr-bg": "color",
  "--fr-rail": "color",
  "--fr-surface": "color",
  "--fr-surface-2": "color",
  "--fr-surface-3": "color",
  "--fr-pill-sunken": "color",
  "--fr-border": "color",
  "--fr-border-soft": "color",
  "--fr-btn-hover-bd": "color",
  "--fr-text": "color",
  "--fr-text-2": "color",
  "--fr-text-3": "color",
  "--fr-add": "color",
  "--fr-add-bg": "color",
  "--fr-del": "color",
  "--fr-del-bg": "color",
  "--fr-del-line": "color",
  "--fr-warn": "color",
  "--fr-warn-ink": "color",
  "--fr-blue": "color",
  "--fr-iris": "color",
  "--fr-scrollbar-thumb": "color",
  "--fr-scrollbar-thumb-hover": "color",
  "--fr-switch-thumb-off": "color",
  "--fr-font-primary": "font",
  "--fr-font-display": "font",
  "--fr-font-secondary": "font",
  "--fr-font-mono": "font",
  "--fr-r": "length",
  "--fr-ui-size": "length"
};
var THEME_TOKENS = Object.keys(THEME_TOKEN_CHANNELS);

// src/deny.ts
var SECRET_DIRECTORIES = {
  ".ssh": true,
  ".gnupg": true,
  ".aws": true,
  ".azure": true,
  ".kube": true,
  ".docker": true,
  ".git": true,
  ".password-store": true,
  keyrings: true,
  // The Personal vault's Locker (`<vault>/locker`, `<vault>/projects/<p>/locker`):
  // sealed entries beside a plaintext control file and audit log. Any folder of
  // that name is refused: over-denying a folder called `locker` is harmless
  // where under-denying one is not.
  locker: true
};
var SECRET_PATHS = [
  [".config", "gcloud"],
  ["microsoft", "credentials"],
  ["microsoft", "protect"],
  ["microsoft", "vault"],
  ["library", "keychains"]
];
var SECRET_FILES = {
  ".netrc": true,
  _netrc: true,
  ".npmrc": true,
  ".pypirc": true,
  ".pgpass": true,
  ".git-credentials": true,
  ".s3cfg": true,
  credentials: true,
  "credentials.json": true,
  "credentials.db": true,
  "secrets.json": true,
  "secrets.yml": true,
  "secrets.yaml": true,
  token: true,
  "token.json": true,
  "tokens.json": true,
  "auth.json": true,
  "service-account.json": true,
  // Browser profile stores.
  "login data": true,
  cookies: true,
  "cookies.sqlite": true,
  "logins.json": true,
  "key3.db": true,
  "key4.db": true,
  // The desktop app's install identity: a bearer for the crowd API.
  "activation.json": true,
  // The Locker's control file, wherever a copy of it ended up (a backup, an export).
  "_locker.json": true
};
var PRIVATE_KEY_FILE = /^(?:id_(?:rsa|dsa|ecdsa|ed25519)(?:\..*)?|.*\.(?:pem|key|p12|pfx|ppk|jks|keystore|kdbx))$/;
var ENVIRONMENT_FILE = /^(?:\.env.*|.*\.env)$/;
var OTHER_SECRET_FILE = /^(?:client_secret.*\.json|.*\.tfstate(?:\.backup)?|.*\.kubeconfig|.*\.secret\.json)$/;
var DATABASE_FILE = /\.(?:db|sqlite3?)(?:-wal|-shm|-journal)?$/;
var ENGINE_HOME = /^\.(?:inso|omp)(?:-[a-z0-9._-]+)?$/;
function denyReason(path) {
  const segments = path.toLowerCase().split(/[\\/]+/).filter((part) => part !== "");
  const base = segments[segments.length - 1] ?? "";
  for (const segment of segments) {
    if (Object.hasOwn(SECRET_DIRECTORIES, segment)) return `it is inside a credentials folder (${segment})`;
  }
  for (const secret of SECRET_PATHS) {
    for (let at = 0; at + secret.length <= segments.length; at++) {
      if (secret.every((part, index) => segments[at + index] === part)) {
        return `it is inside a credentials store (${secret.join("/")})`;
      }
    }
  }
  if (ENVIRONMENT_FILE.test(base)) return "it is an environment file (.env), which holds secrets";
  if (PRIVATE_KEY_FILE.test(base)) return "it is a private key or certificate file";
  if (Object.hasOwn(SECRET_FILES, base) || OTHER_SECRET_FILE.test(base)) return "it is a credentials or token file";
  for (let at = 0; at < segments.length; at++) {
    if (!ENGINE_HOME.test(segments[at] ?? "")) continue;
    const next = segments[at + 1];
    if (next === "agent" || next === "profiles" && segments[at + 3] === "agent") {
      return "it is the engine's agent state (credentials, sessions and databases)";
    }
    if (DATABASE_FILE.test(base)) return "it is a database inside an engine home";
  }
  return void 0;
}
function textRefusal(requested, platform = process.platform) {
  if (requested.trim() === "") return "the path is empty";
  if (requested.includes("\0")) return "the path contains a NUL byte";
  if (platform === "win32") {
    if (/^[\\/]{2}[.?][\\/]/.test(requested)) return "Windows device paths (\\\\.\\ and \\\\?\\) are not presentable";
    if (requested.slice(2).includes(":")) return "alternate data streams (a ':' after the drive) are not presentable";
    if (/^[\\/]{2}/.test(requested)) return "network paths (\\\\host\\share) are not presentable";
  }
  return void 0;
}

// src/thumbnail.ts
var THUMB_EDGE = 768;
var MAX_THUMB_BYTES = 150 * 1024;
var MAX_THUMB_SOURCE_BYTES = 25 * 1024 * 1024;
var MAX_THUMB_PIXELS = 25e6;
var JPEG_QUALITIES = [75, 55];
var SMALLER_EDGES = [512, 320];
var SMALLER_EDGE_QUALITY = 50;
function thumbnail(bytes, mimeType) {
  return { data: Buffer.from(bytes).toString("base64"), mimeType, bytes: bytes.length };
}
async function imageFacts(source, maxBytes) {
  if (typeof Bun === "undefined") return void 0;
  try {
    const options = { maxPixels: MAX_THUMB_PIXELS };
    const { width, height } = await new Bun.Image(source, options).metadata();
    if (!(width > 0 && height > 0)) return void 0;
    if (maxBytes <= 0) return { width, height };
    const fit = { fit: "inside", withoutEnlargement: true };
    const base = await new Bun.Image(source, options).resize(THUMB_EDGE, THUMB_EDGE, fit).png().bytes();
    if (base.length <= maxBytes) return { width, height, thumb: thumbnail(base, "image/png") };
    for (const quality of JPEG_QUALITIES) {
      const jpeg = await new Bun.Image(base).jpeg({ quality }).bytes();
      if (jpeg.length <= maxBytes) return { width, height, thumb: thumbnail(jpeg, "image/jpeg") };
    }
    for (const edge of SMALLER_EDGES) {
      const jpeg = await new Bun.Image(base).resize(edge, edge, fit).jpeg({ quality: SMALLER_EDGE_QUALITY }).bytes();
      if (jpeg.length <= maxBytes) return { width, height, thumb: thumbnail(jpeg, "image/jpeg") };
    }
    return { width, height };
  } catch {
    return void 0;
  }
}

// src/present.ts
var HEAD_BYTES = 512;
var MAX_RESULT_THUMB_BYTES = 600 * 1024;
var MAX_ECHO = 200;
var SVG = "image/svg+xml";
var UNSAFE_IN_A_LINE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g;
function oneLine(text, max) {
  const flat = text.replace(UNSAFE_IN_A_LINE, " ");
  if (flat.length <= max) return flat;
  let units = 0;
  let points = 0;
  for (const point of flat) {
    if (points === max) return `${flat.slice(0, units)}...`;
    units += point.length;
    points++;
  }
  return flat;
}
function readOnlyFlags(flags = constants) {
  return flags.O_RDONLY | (flags.O_NONBLOCK ?? 0);
}
function nonFileReason(info) {
  if (info.isDirectory()) return "it is a directory, not a file";
  return info.isFile() ? void 0 : "it is not a regular file";
}
function unresolvedReason(error) {
  const code = error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : void 0;
  if (code === "ENOENT" || code === "ENOTDIR") return "no such file";
  if (code === "EACCES" || code === "EPERM") return "permission denied";
  return `it cannot be resolved${code ? ` (${code})` : ""}`;
}
async function readWhole(handle, size) {
  const buffer = Buffer.allocUnsafe(size);
  let filled = 0;
  while (filled < size) {
    const { bytesRead } = await handle.read(buffer, filled, size - filled, filled);
    if (bytesRead === 0) break;
    filled += bytesRead;
  }
  return buffer.subarray(0, filled);
}
async function presentOne(requested, run, thumbBudget) {
  if (typeof requested !== "string") return { refused: "it is not a path" };
  const textual = textRefusal(requested, run.platform);
  if (textual !== void 0) return { refused: textual };
  const lexical = resolve(run.cwd, requested);
  const early = denyReason(lexical);
  if (early !== void 0) return { refused: early };
  let real;
  try {
    real = await realpath(lexical);
  } catch (error) {
    return { refused: unresolvedReason(error) };
  }
  if (denyReason(real) !== void 0)
    return { refused: "it resolves to a protected location (credentials, keys or engine state)" };
  if (run.seen.has(real)) return void 0;
  let info;
  try {
    info = await stat(real);
  } catch (error) {
    return { refused: unresolvedReason(error) };
  }
  const notFile = nonFileReason(info);
  if (notFile !== void 0) return { refused: notFile };
  let handle;
  try {
    handle = await run.open(real, readOnlyFlags());
  } catch (error) {
    return { refused: unresolvedReason(error) };
  }
  try {
    const opened = await handle.stat();
    const swapped = nonFileReason(opened);
    if (swapped !== void 0) return { refused: swapped };
    const head = Buffer.allocUnsafe(Math.min(HEAD_BYTES, opened.size));
    const { bytesRead } = await handle.read(head, 0, head.length, 0);
    const fileName = basename(real);
    const { kind, mime } = classifyFile(fileName, head.subarray(0, bytesRead));
    run.seen.add(real);
    const name = oneLine(fileName, MAX_ECHO);
    const base = { path: real, name, kind, mime, size: opened.size, mtimeMs: opened.mtimeMs };
    if (kind !== "image" || mime === SVG || opened.size > MAX_THUMB_SOURCE_BYTES) return { item: base };
    const facts = await imageFacts(await readWhole(handle, opened.size), Math.min(MAX_THUMB_BYTES, thumbBudget));
    if (facts === void 0) return { item: base };
    return { item: { ...base, width: facts.width, height: facts.height }, thumb: facts.thumb };
  } finally {
    await handle.close();
  }
}
async function presentPaths(input, options) {
  const all = typeof input === "string" ? [input] : input;
  const requested = all.slice(0, MAX_PRESENTED_ITEMS);
  const lines = [];
  const items = [];
  const images = [];
  const run = {
    cwd: options.cwd,
    platform: options.platform ?? process.platform,
    open: options.open ?? open,
    seen: /* @__PURE__ */ new Set()
  };
  let thumbBytes = 0;
  for (const path of requested) {
    options.signal?.throwIfAborted();
    const outcome = await presentOne(path, run, MAX_RESULT_THUMB_BYTES - thumbBytes);
    if (outcome === void 0) continue;
    if ("refused" in outcome) {
      const shown = oneLine(String(path), MAX_ECHO).trim() || "(empty path)";
      lines.push(`Could not present ${shown}: ${outcome.refused}.`);
      continue;
    }
    const { item, thumb } = outcome;
    if (thumb !== void 0) {
      thumbBytes += thumb.bytes;
      images.push({ data: thumb.data, mimeType: thumb.mimeType });
    }
    items.push(thumb === void 0 ? item : { ...item, thumb: images.length - 1 });
    lines.push(`Presented ${item.name} (${PRESENTED_KIND_LABELS[item.kind]}, ${formatByteSize(item.size)}).`);
  }
  if (all.length > requested.length) {
    lines.push(`Only the first ${requested.length} of ${all.length} paths were presented.`);
  }
  if (items.length === 0) throw new Error(lines.join("\n") || "Nothing to present: pass the path of a file.");
  return {
    text: lines.join("\n"),
    details: { presentation: { items }, ...images.length > 0 ? { images } : {} }
  };
}

// src/index.ts
function swissKnife(pi) {
  const z = pi.zod;
  pi.registerTool({
    name: "present",
    label: "Present",
    // It reads a file the agent could already read and shows it to the human:
    // never a prompt, never a write.
    approval: "read",
    description: "Show the user one or more files (images, PDFs, documents, decks, sheets) as cards they can open and annotate.",
    parameters: z.object({
      path: z.union([z.string(), z.array(z.string())]).describe("Absolute file path, or an array of up to 12 paths.")
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const { text, details } = await presentPaths(params.path, { cwd: ctx.cwd, signal });
      return { content: [{ type: "text", text }], details };
    }
  });
}
export {
  swissKnife as default
};

// ../../../fraym/packages/driver/src/classify-file.ts
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

// ../../../fraym/packages/driver/src/type-guards.ts
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
var KIND_SET = new Set(PRESENTED_KINDS);

// ../../../fraym/packages/driver/src/generative-ui.ts
var GENERATIVE_UI_DETAILS_KEY = "generativeUi";
var UI_SPEC_VERSION = 1;
var UI_LIMITS = {
  maxSpecBytes: 48 * 1024,
  maxNodes: 400,
  maxDepth: 8,
  maxBlocks: 60,
  maxChildren: 60,
  maxButtons: 12,
  maxIssues: 8,
  maxTitle: 120,
  maxLabel: 160,
  maxText: 2e3,
  maxCell: 400,
  maxMessage: 500,
  maxUrl: 2048,
  maxItems: 100,
  maxTableRows: 200,
  maxTableColumns: 12,
  maxOptions: 6,
  maxTabs: 12,
  maxLabels: 60,
  maxSeries: 6
};
var UI_TONES = ["neutral", "muted", "info", "success", "warning", "danger"];
var L = UI_LIMITS;
var label = (max = L.maxLabel) => ({ k: "str", max, inline: false });
var text = (max = L.maxText) => ({ k: "str", max, inline: true });
var pick = (...values) => ({ k: "enum", values });
var int = (min, max) => ({ k: "int", min, max });
var flag = { k: "bool" };
var tone = { k: "enum", values: UI_TONES };
var kids = { k: "nodes" };
var items = (of, max = L.maxItems, min = 1) => ({ k: "list", of, min, max });
var shape = (fields, shorthand) => shorthand === void 0 ? { k: "shape", fields } : { k: "shape", fields, shorthand };
var PALETTE = {
  stack: {
    group: "Layout",
    fields: { children: kids, "direction?": pick("column", "row"), "gap?": pick("sm", "md", "lg") }
  },
  grid: { group: "Layout", fields: { children: kids, "columns?": int(1, 4) } },
  card: {
    group: "Layout",
    fields: { "title?": label(), "subtitle?": label(), "tone?": tone, children: kids }
  },
  tabs: {
    group: "Layout",
    fields: { tabs: items(shape({ label: label(60), children: kids }), L.maxTabs) }
  },
  collapse: { group: "Layout", fields: { title: label(), "open?": flag, children: kids } },
  divider: { group: "Layout", fields: {} },
  heading: { group: "Text", fields: { text: label(200), "level?": int(1, 3) } },
  text: { group: "Text", fields: { text: text(), "tone?": tone } },
  callout: { group: "Text", fields: { "tone?": tone, "title?": label(), text: text() } },
  tags: {
    group: "Text",
    fields: { items: items(shape({ text: label(60), "tone?": tone }, "text"), 30) }
  },
  list: {
    group: "Lists",
    fields: {
      "ordered?": flag,
      items: items(shape({ text: text(400), "detail?": text(400) }, "text"))
    }
  },
  checklist: {
    group: "Lists",
    fields: {
      "title?": label(),
      items: items(shape({ text: text(300), "detail?": text(300), "checked?": flag }, "text")),
      "submit?": label(60)
    }
  },
  kv: {
    group: "Lists",
    fields: {
      "columns?": int(1, 2),
      items: items(shape({ label: label(80), value: text(400), "detail?": text(300) }))
    }
  },
  timeline: {
    group: "Lists",
    fields: {
      items: items(
        shape({ "time?": label(60), title: label(200), "detail?": text(600), "tag?": label(40), "tone?": tone })
      )
    }
  },
  table: {
    group: "Data",
    fields: {
      "caption?": label(),
      columns: items(
        shape({ label: label(60), "align?": pick("start", "center", "end") }, "label"),
        L.maxTableColumns
      ),
      rows: items({ k: "list", of: { k: "cell" }, min: 0, max: L.maxTableColumns }, L.maxTableRows)
    },
    check(node, path, issue) {
      const columns = Array.isArray(node.columns) ? node.columns.length : 0;
      const rows = Array.isArray(node.rows) ? node.rows : [];
      rows.forEach((row, index) => {
        if (Array.isArray(row) && row.length > columns) {
          issue(`${path}.rows[${index}]`, `has ${row.length} cells but there are only ${columns} columns`);
        }
      });
    }
  },
  comparison: {
    group: "Data",
    fields: {
      options: items(
        shape({
          name: label(80),
          "tagline?": label(),
          "recommended?": flag,
          "facts?": items(shape({ label: label(80), value: text(300) }), 12, 0),
          "pros?": items(text(300), 8, 0),
          "cons?": items(text(300), 8, 0)
        }),
        L.maxOptions,
        2
      )
    }
  },
  stats: {
    group: "Data",
    fields: {
      items: items(
        shape({
          label: label(80),
          value: label(40),
          "unit?": label(16),
          "delta?": label(40),
          "trend?": pick("up", "down", "flat"),
          "detail?": label(),
          "tone?": tone
        }),
        12
      )
    }
  },
  progress: {
    group: "Data",
    fields: {
      label: label(),
      value: { k: "num", nullable: false },
      "max?": { k: "num", nullable: false },
      "detail?": label(),
      "tone?": tone
    }
  },
  chart: {
    group: "Data",
    fields: {
      kind: pick("bar", "line", "donut"),
      "title?": label(),
      labels: items(label(40), L.maxLabels),
      series: items(
        shape({ name: label(60), values: items({ k: "num", nullable: true }, L.maxLabels) }),
        L.maxSeries
      ),
      "unit?": label(16)
    },
    check(node, path, issue) {
      const labels = Array.isArray(node.labels) ? node.labels.length : 0;
      const series = Array.isArray(node.series) ? node.series : [];
      if (node.kind === "donut" && series.length > 1) issue(`${path}.series`, "a donut takes exactly one series");
      series.forEach((entry, index) => {
        const values = isRecord(entry) && Array.isArray(entry.values) ? entry.values.length : labels;
        if (values !== labels)
          issue(`${path}.series[${index}].values`, `has ${values} values but there are ${labels} labels`);
      });
    }
  },
  button: {
    group: "Interactive",
    fields: { label: label(60), message: label(L.maxMessage), "variant?": pick("primary", "secondary") }
  },
  link: {
    group: "Media",
    fields: { label: label(), url: { k: "url", schemes: ["https:", "mailto:"] }, "detail?": label() }
  },
  image: {
    group: "Media",
    fields: { url: { k: "url", schemes: ["https:"] }, alt: label(200), "caption?": label() }
  }
};
var UI_NODE_TYPES = Object.keys(PALETTE);
var TYPE_ALIASES = {
  stat: "stats",
  kpi: "stats",
  metrics: "stats",
  metric: "stats",
  row: "stack",
  column: "stack",
  vstack: "stack",
  hstack: "stack",
  flex: "stack",
  columns: "grid",
  section: "card",
  panel: "card",
  paragraph: "text",
  p: "text",
  markdown: "text",
  h1: "heading",
  h2: "heading",
  h3: "heading",
  title: "heading",
  bullets: "list",
  ul: "list",
  ol: "list",
  todo: "checklist",
  todos: "checklist",
  check: "checklist",
  keyvalue: "kv",
  key_value: "kv",
  details: "kv",
  itinerary: "timeline",
  schedule: "timeline",
  steps: "timeline",
  compare: "comparison",
  pros_cons: "comparison",
  bar: "chart",
  line: "chart",
  donut: "chart",
  pie: "chart",
  accordion: "collapse",
  disclosure: "collapse",
  alert: "callout",
  note: "callout",
  badge: "tags",
  badges: "tags",
  chip: "tags",
  chips: "tags",
  hr: "divider",
  separator: "divider",
  a: "link",
  img: "image",
  picture: "image",
  action: "button",
  cta: "button"
};
var ACTIVE_MARKUP = /<\s*\/?\s*(?:script|iframe|object|embed|style|link|meta|base|form|svg|math|img|video|audio|source|applet|frame|frameset|template|portal|noscript|input|button|textarea|select)\b|<!--|<!\[CDATA\[|\bon[a-z]{3,}\s*=\s*["'`]|(?:javascript|vbscript)\s*:|data\s*:\s*text\/html/i;
var UNSAFE_CODE_RANGES = [
  [0, 8],
  [11, 12],
  [14, 31],
  [127, 159],
  [8203, 8207],
  [8232, 8233],
  [8234, 8238],
  [8288, 8292],
  [8294, 8297],
  [65279, 65279]
];
var INLINE_LINK = /\[([^\]\n]*)\]\(([^)\s]*)\)/g;
function editDistance(a, b) {
  if (Math.abs(a.length - b.length) > 2) return 3;
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) {
      const substitution = (previous[j - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1);
      row.push(Math.min(substitution, (previous[j] ?? 0) + 1, (row[j - 1] ?? 0) + 1));
    }
    previous = row;
  }
  return previous[b.length] ?? 3;
}
function closest(word, candidates) {
  const lower = word.toLowerCase();
  let best;
  let bestDistance = 3;
  for (const candidate of candidates) {
    const distance = editDistance(lower, candidate.toLowerCase());
    if (distance < bestDistance) {
      best = candidate;
      bestDistance = distance;
    }
  }
  return best;
}
function safeUrl(value, schemes) {
  if (typeof value !== "string" || value.length === 0 || value.length > L.maxUrl) return void 0;
  let parsed;
  try {
    parsed = new URL(value.trim());
  } catch {
    return void 0;
  }
  if (!schemes.includes(parsed.protocol)) return void 0;
  if (parsed.username !== "" || parsed.password !== "") return void 0;
  if (parsed.protocol === "mailto:") return parsed.pathname === "" ? void 0 : parsed.href;
  return parsed.hostname === "" ? void 0 : parsed.href;
}
var INVALID = Symbol("invalid");
function fail(run, path, message) {
  if (run.issues.length < L.maxIssues) run.issues.push({ path, message });
  else run.more++;
  return INVALID;
}
function describeValue(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  return typeof value === "object" ? "an object" : `a ${typeof value}`;
}
function cleanText(value, multiline) {
  let kept = "";
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if (!UNSAFE_CODE_RANGES.some(([low, high]) => code >= low && code <= high)) kept += char;
  }
  const stripped = kept.replace(/\r\n?/g, "\n");
  return (multiline ? stripped : stripped.replace(/\s*\n\s*/g, " ")).trim();
}
function parseString(raw, field, path, run) {
  if (typeof raw === "number" && Number.isFinite(raw)) raw = String(raw);
  if (typeof raw === "boolean") raw = String(raw);
  if (typeof raw !== "string") return fail(run, path, `expected a string, got ${describeValue(raw)}`);
  const value = cleanText(raw, field.inline);
  if (value.length > field.max)
    return fail(run, path, `is too long (${value.length} characters, the limit is ${field.max})`);
  if (ACTIVE_MARKUP.test(value)) {
    return fail(
      run,
      path,
      "contains HTML or script-like markup; every string is plain text (only **bold**, *italic*, `code` and [label](https://url) are understood)"
    );
  }
  if (field.inline) {
    for (const match of value.matchAll(INLINE_LINK)) {
      if (safeUrl(match[2], ["https:", "mailto:"]) === void 0) {
        return fail(
          run,
          path,
          `has a link with a URL that is not allowed (${JSON.stringify(match[2]).slice(0, 60)}); only https: and mailto: links are rendered`
        );
      }
    }
  }
  return value;
}
function parseField(raw, field, path, run, depth) {
  switch (field.k) {
    case "str":
      return parseString(raw, field, path, run);
    case "enum": {
      const match = typeof raw === "string" ? field.values.find((value) => value === raw.trim().toLowerCase()) : void 0;
      if (match !== void 0) return match;
      return fail(
        run,
        path,
        `expected ${field.values.map((value) => JSON.stringify(value)).join(" | ")}, got ${JSON.stringify(raw)?.slice(0, 40)}`
      );
    }
    case "int": {
      const number = typeof raw === "string" && raw.trim() !== "" ? Number(raw) : raw;
      if (typeof number !== "number" || !Number.isFinite(number))
        return fail(run, path, `expected a whole number ${field.min}-${field.max}`);
      const rounded = Math.round(number);
      const clamped = Math.min(field.max, Math.max(field.min, rounded));
      if (clamped !== number)
        run.warnings.add(`${path}: ${number} was changed to ${clamped} (allowed ${field.min}-${field.max})`);
      return clamped;
    }
    case "num": {
      if (raw === null && field.nullable) return null;
      const number = typeof raw === "string" && raw.trim() !== "" ? Number(raw) : raw;
      if (typeof number !== "number" || !Number.isFinite(number))
        return fail(
          run,
          path,
          `expected a finite number${field.nullable ? " or null" : ""}, got ${JSON.stringify(raw)?.slice(0, 40)}`
        );
      return number;
    }
    case "bool":
      if (typeof raw === "boolean") return raw;
      if (raw === "true" || raw === "false") return raw === "true";
      return fail(run, path, "expected true or false");
    case "cell": {
      if (raw === null || typeof raw === "boolean") return raw;
      if (typeof raw === "number") return Number.isFinite(raw) ? raw : fail(run, path, "expected a finite number");
      return parseString(raw, { k: "str", max: L.maxCell, inline: false }, path, run);
    }
    case "url": {
      if (typeof raw !== "string") return fail(run, path, "expected a URL string");
      const url = safeUrl(raw, field.schemes);
      if (url === void 0)
        return fail(
          run,
          path,
          `is not an allowed URL (${field.schemes.join(" or ")} only, no credentials, at most ${L.maxUrl} characters)`
        );
      return url;
    }
    case "nodes":
      return parseNodes(raw, path, run, depth + 1);
    case "list": {
      if (!Array.isArray(raw)) return fail(run, path, `expected an array, got ${describeValue(raw)}`);
      if (raw.length < field.min)
        return fail(run, path, `needs at least ${field.min} ${field.min === 1 ? "entry" : "entries"}`);
      if (raw.length > field.max) return fail(run, path, `has ${raw.length} entries, the limit is ${field.max}`);
      const out = [];
      let bad = false;
      raw.forEach((entry, index) => {
        const value = parseField(entry, field.of, `${path}[${index}]`, run, depth);
        if (value === INVALID) bad = true;
        else out.push(value);
      });
      return bad ? INVALID : out;
    }
    case "shape": {
      let source = raw;
      if (field.shorthand !== void 0 && (typeof raw === "string" || typeof raw === "number"))
        source = { [field.shorthand]: raw };
      if (!isRecord(source))
        return fail(
          run,
          path,
          `expected an object${field.shorthand ? ` or a string` : ""}, got ${describeValue(raw)}`
        );
      return parseFields(source, field.fields, path, run, depth, "object");
    }
  }
}
function parseFields(source, fields, path, run, depth, owner) {
  const out = {};
  let bad = false;
  const known = /* @__PURE__ */ new Set();
  for (const [declared, field] of Object.entries(fields)) {
    const optional = declared.endsWith("?");
    const key = optional ? declared.slice(0, -1) : declared;
    known.add(key);
    const raw = source[key];
    if (raw === void 0 || raw === null && field.k !== "num" && field.k !== "cell") {
      if (!optional) bad = fail(run, `${path}.${key}`, `is required (${describeField(field)})`) === INVALID || bad;
      continue;
    }
    const value = parseField(raw, field, `${path}.${key}`, run, depth);
    if (value === INVALID) bad = true;
    else out[key] = value;
  }
  for (const key of Object.keys(source)) {
    if (known.has(key) || key === "type") continue;
    const hint = closest(key, [...known]);
    run.warnings.add(`${path}.${key}: ignored, ${owner} has no "${key}"${hint ? ` (did you mean "${hint}"?)` : ""}`);
  }
  return bad ? INVALID : out;
}
function parseNodes(raw, path, run, depth) {
  if (!Array.isArray(raw)) return fail(run, path, `expected an array of blocks, got ${describeValue(raw)}`);
  if (raw.length === 0) return fail(run, path, "needs at least one block");
  if (raw.length > L.maxChildren) return fail(run, path, `has ${raw.length} children, the limit is ${L.maxChildren}`);
  const out = [];
  let bad = false;
  raw.forEach((entry, index) => {
    if (run.overflow) return;
    const node = parseNode(entry, `${path}[${index}]`, run, depth);
    if (node === INVALID) bad = true;
    else out.push(node);
  });
  return bad ? INVALID : out;
}
function parseNode(raw, path, run, depth) {
  const source = typeof raw === "string" ? { type: "text", text: raw } : raw;
  if (!isRecord(source))
    return fail(run, path, `expected a block object like {"type":"text","text":"..."}, got ${describeValue(raw)}`);
  const type = source.type;
  if (typeof type !== "string") return fail(run, path, `needs a "type" (one of: ${UI_NODE_TYPES.join(", ")})`);
  const spec = Object.hasOwn(PALETTE, type) ? PALETTE[type] : void 0;
  if (spec === void 0) {
    const alias = TYPE_ALIASES[type.toLowerCase()] ?? closest(type, UI_NODE_TYPES);
    return fail(
      run,
      path,
      `"${type}" is not a block type${alias ? `; use "${alias}"` : ""} (types: ${UI_NODE_TYPES.join(", ")})`
    );
  }
  if (depth > L.maxDepth) {
    run.overflow = true;
    return fail(run, path, `is nested ${depth} levels deep, the limit is ${L.maxDepth}; flatten the layout`);
  }
  run.nodes++;
  if (run.nodes > L.maxNodes) {
    run.overflow = true;
    return fail(run, path, `the interface has more than ${L.maxNodes} blocks; split it or cut detail`);
  }
  if (depth > run.depth) run.depth = depth;
  run.kinds[type] = (run.kinds[type] ?? 0) + 1;
  if (type === "button") {
    run.buttons++;
    if (run.buttons > L.maxButtons) return fail(run, path, `the interface has more than ${L.maxButtons} buttons`);
  }
  const fields = parseFields(source, spec.fields, path, run, depth, `"${type}"`);
  if (fields === INVALID) return INVALID;
  if (spec.check) {
    const before = run.issues.length + run.more;
    spec.check(source, path, (at, message) => void fail(run, at, message));
    if (run.issues.length + run.more > before) return INVALID;
  }
  return { type, ...fields };
}
function describeField(field) {
  switch (field.k) {
    case "str":
      return "text";
    case "enum":
      return field.values === UI_TONES ? "TONE" : field.values.join("|");
    case "int":
      return `${field.min}-${field.max}`;
    case "num":
      return field.nullable ? "number|null" : "number";
    case "bool":
      return "bool";
    case "cell":
      return "text|number";
    case "url":
      return `${field.schemes.join("|")} url`;
    case "nodes":
      return "[blocks]";
    case "list":
      return `[${describeField(field.of)}]`;
    case "shape": {
      const inner = describeFields(field.fields);
      return field.shorthand ? `text|{${inner}}` : `{${inner}}`;
    }
  }
}
var SELF_EXPLAINING = { str: true, nodes: true, url: true, num: true, cell: true };
function describeFields(fields) {
  return Object.entries(fields).map(([declared, field]) => SELF_EXPLAINING[field.k] ? declared : `${declared}:${describeField(field)}`).join(",");
}
function describeUiPalette() {
  const groups = /* @__PURE__ */ new Map();
  for (const [type, spec] of Object.entries(PALETTE)) {
    const list = groups.get(spec.group) ?? [];
    list.push(`${type}{${describeFields(spec.fields)}}`);
    groups.set(spec.group, list);
  }
  const lines = [...groups.entries()].map(([group, entries]) => `${group}: ${entries.join(" ")}`);
  return [...lines, `TONE = ${UI_TONES.join("|")}`].join("\n");
}
function parseUiSpec(input) {
  const run = {
    issues: [],
    warnings: /* @__PURE__ */ new Set(),
    kinds: {},
    nodes: 0,
    depth: 0,
    buttons: 0,
    overflow: false,
    more: 0
  };
  const reject = () => ({ ok: false, issues: run.issues, more: run.more });
  if (!isRecord(input)) {
    fail(run, "(root)", `expected an object like {"title":"...","blocks":[...]}, got ${describeValue(input)}`);
    return reject();
  }
  let size = 0;
  try {
    size = JSON.stringify(input).length;
  } catch {
    fail(run, "(root)", "is not plain JSON data");
    return reject();
  }
  if (size > L.maxSpecBytes) {
    fail(
      run,
      "(root)",
      `is ${Math.ceil(size / 1024)} KiB, the limit is ${L.maxSpecBytes / 1024} KiB; cut detail or split the interface`
    );
    return reject();
  }
  if (input.v !== void 0 && input.v !== UI_SPEC_VERSION) {
    fail(run, "v", `is ${JSON.stringify(input.v)}; this renderer reads version ${UI_SPEC_VERSION}`);
    return reject();
  }
  let title;
  if (input.title !== void 0 && input.title !== null) {
    const parsed = parseString(input.title, { k: "str", max: L.maxTitle, inline: false }, "title", run);
    if (parsed !== INVALID && parsed !== "") title = parsed;
  }
  if (input.blocks === void 0) {
    const stray = ["root", "ui", "children", "content", "sections", "components", "layout"].find(
      (key) => input[key] !== void 0
    );
    fail(
      run,
      "blocks",
      `is required: an array of blocks, e.g. {"blocks":[{"type":"heading","text":"Hi"}]}${stray ? `; move the content of "${stray}" into "blocks"` : ""}`
    );
    return reject();
  }
  if (Array.isArray(input.blocks) && input.blocks.length > L.maxBlocks) {
    fail(
      run,
      "blocks",
      `has ${input.blocks.length} blocks, the limit is ${L.maxBlocks}; group them with card or tabs`
    );
    return reject();
  }
  const blocks = parseNodes(input.blocks, "blocks", run, 1);
  if (blocks === INVALID || run.issues.length > 0) return reject();
  const spec = title === void 0 ? { v: UI_SPEC_VERSION, blocks } : { v: UI_SPEC_VERSION, title, blocks };
  return {
    ok: true,
    spec,
    warnings: [...run.warnings].slice(0, L.maxIssues),
    stats: { nodes: run.nodes, depth: run.depth, buttons: run.buttons, kinds: run.kinds }
  };
}
function formatUiIssues(result) {
  const lines = result.issues.map((issue) => `- ${issue.path}: ${issue.message}`);
  if (result.more > 0) lines.push(`- ...and ${result.more} more`);
  return [
    "The interface was NOT shown. Fix the problems below and call render_ui again with the corrected whole interface.",
    ...lines,
    `Block types: ${UI_NODE_TYPES.join(", ")}.`
  ].join("\n");
}
function summarizeUiSpec(spec, stats, warnings) {
  const kinds = Object.entries(stats.kinds).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([kind, count]) => count > 1 ? `${kind} x${count}` : kind).join(", ");
  const lines = [
    `Shown to the user${spec.title ? `: "${spec.title}"` : ""}. ${stats.nodes} blocks (${kinds}). Do not repeat its content in your reply; add at most one short sentence.`
  ];
  if (stats.buttons > 0) lines.push("Button clicks arrive as the user's next message.");
  if (warnings.length > 0) lines.push(`Ignored: ${warnings.join("; ")}`);
  return lines.join("\n");
}
var WIRE_CHUNK_CHARS = 12e3;
function encodeUiSpec(spec) {
  const text2 = JSON.stringify(spec);
  const json = [];
  for (let at = 0; at < text2.length; at += WIRE_CHUNK_CHARS) json.push(text2.slice(at, at + WIRE_CHUNK_CHARS));
  return { v: UI_SPEC_VERSION, json };
}

// ../../../fraym/packages/driver/src/room-types.ts
var ROOM_UPLOAD_MAX_BYTES = 10 * 1024 * 1024;
var ROOM_PREVIEW_MAX_BYTES = 8 * 1024 * 1024;

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

// ../../../fraym/packages/driver/src/types.ts
var TERMINAL_CONTINUATION_REASONS = Object.assign(
  /* @__PURE__ */ Object.create(null),
  { handoff: true, new: true, plan: true, drop: true, move: true, recover: true }
);

// src/index.ts
var TOOL_NAME = "render_ui";
function toolDescription() {
  return [
    "Show the user a designed interface instead of a wall of text: a trip plan, a comparison, a checklist, a schedule, a summary with numbers. Use it when structure helps the reader; answer ordinary questions in plain chat.",
    "Call it once with the WHOLE page, then reply with at most one short sentence: the interface is already on screen, so never repeat its content.",
    "Input: {title?, blocks:[block,...]}. A block is {type, ...props}; `name?` is optional; `children` are blocks. Strings are plain text that may use **bold**, *italic*, `code` and [label](https://url). No HTML, no scripts, https links only.",
    describeUiPalette(),
    "A button sends its `message` as the user's next message when clicked: word it as the user would say it. A checklist with `submit` sends the ticked and unticked items back the same way.",
    "Good pages: a heading, short blocks, tabs for days or options, a table or comparison for options, stats and a chart for numbers, one callout for the thing to remember.",
    `Limits: ${UI_LIMITS.maxNodes} blocks, ${UI_LIMITS.maxDepth} levels deep, ${UI_LIMITS.maxSpecBytes / 1024} KiB. A bad block is refused with the exact path to fix: correct it and call again.`
  ].join("\n");
}
function generativeUi(pi) {
  const z = pi.zod;
  pi.registerTool({
    name: TOOL_NAME,
    label: "Interface",
    approval: "read",
    description: toolDescription(),
    parameters: z.object({
      title: z.string().optional().describe("Heading of the whole interface."),
      blocks: z.array(z.unknown()).describe("The page: blocks from the grammar above, top to bottom.")
    }),
    async execute(_toolCallId, params) {
      const result = parseUiSpec(params);
      if (!result.ok) throw new Error(formatUiIssues(result));
      return {
        content: [{ type: "text", text: summarizeUiSpec(result.spec, result.stats, result.warnings) }],
        details: { [GENERATIVE_UI_DETAILS_KEY]: encodeUiSpec(result.spec) }
      };
    }
  });
}
export {
  TOOL_NAME,
  generativeUi as default,
  toolDescription
};

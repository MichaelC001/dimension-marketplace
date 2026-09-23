#!/usr/bin/env node
// Browser task-agent benchmark: runs each task agent against the five practice careers sites
// through the pack's MCP server (app/server.mjs over stdio) and scores submissions via /__results.
import { mkdir, writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const USAGE = `Usage: node bench/run.mjs [options]

Runs browser task agents against local practice job-application sites and prints a scorecard.

Options:
  --agents <list>     Comma-separated task agents (default: jev,browser-use)
  --sites <list>      Comma-separated sites (default: acme,globex,initech,umbrella,hooli)
  --engine <name>     Browser engine for browser_open (default: chromium)
  --headed            Show the browser window (DIMENSION_BROWSER_HEADLESS=false)
  --port <n>          Practice sites port; started in-process if not already running (default: 4777)
  --max-steps <n>     maxSteps passed to browser_task (default: 40)
  --timeout <sec>     Hard wall-clock limit per task (default: 600)
  -h, --help          Show this help

Results: markdown table on stdout, raw JSON in bench/results/<timestamp>.json.
Agents need their model keys in the environment (TYPESAFE_API_KEY for jev, OPENAI_API_KEY for browser-use).`;

const ALL_SITES = ["acme", "globex", "initech", "umbrella", "hooli"];
const list = (s) => s.split(",").map((x) => x.trim()).filter(Boolean);

const { values: opts } = parseArgs({
  options: {
    agents: { type: "string", default: "jev,browser-use" },
    sites: { type: "string", default: ALL_SITES.join(",") },
    engine: { type: "string", default: "chromium" },
    headed: { type: "boolean", default: false },
    port: { type: "string", default: "4777" },
    "max-steps": { type: "string", default: "40" },
    timeout: { type: "string", default: "600" },
    help: { type: "boolean", short: "h", default: false },
  },
});
if (opts.help) {
  console.log(USAGE);
  process.exit(0);
}

const agents = list(opts.agents);
const sites = list(opts.sites);
const unknown = sites.filter((s) => !ALL_SITES.includes(s));
if (unknown.length) {
  console.error(`Unknown site(s): ${unknown.join(", ")}. Known: ${ALL_SITES.join(", ")}`);
  process.exit(2);
}
const maxSteps = Number(opts["max-steps"]);
const taskTimeoutMs = Number(opts.timeout) * 1000;

const packDir = fileURLToPath(new URL("../", import.meta.url));
const serverPath = fileURLToPath(new URL("../app/server.mjs", import.meta.url));
if (!existsSync(serverPath)) {
  console.error(`Missing ${serverPath}; run \`npm run build\` in packs/browser first.`);
  process.exit(2);
}
const applicant = JSON.parse(readFileSync(new URL("./applicant.json", import.meta.url), "utf8"));

// ---------------------------------------------------------------- practice sites

const base = `http://127.0.0.1:${opts.port}`;
let sitesServer = null;
try {
  await fetch(`${base}/__results`);
} catch {
  const { startSites } = await import("./sites/server.mjs");
  sitesServer = (await startSites(Number(opts.port))).server;
  console.log(`[bench] started practice sites on ${base}`);
}
const siteResults = async () => (await fetch(`${base}/__results`)).json();
const resetSites = () => fetch(`${base}/__reset`, { method: "POST" });

function taskText(url) {
  const a = applicant;
  return `Apply to the Frontend Engineer job at ${url} using this applicant:
First name: ${a.firstName}
Last name: ${a.lastName}
Full name: ${a.firstName} ${a.lastName}
Email: ${a.email}
Phone: ${a.phone}
City: ${a.city}
Years of professional experience: ${a.yearsExperience}
LinkedIn: ${a.linkedin}
Authorized to work in the US: ${a.workAuthorized ? "yes" : "no"}
Skills: ${a.skills.join(", ")}
Cover letter: ${a.coverLetter}
Fill in every field the application form asks for using exactly this data, accept any required consent, and submit the application. You are done when the site confirms the application was received.`;
}

// ---------------------------------------------------------------- MCP client

const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");

const stderrTail = [];
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [serverPath],
  cwd: packDir,
  env: { ...process.env, DIMENSION_BROWSER_HEADLESS: opts.headed ? "false" : "true" },
  stderr: "pipe",
});
transport.stderr?.on("data", (chunk) => {
  stderrTail.push(...String(chunk).split(/\r?\n/).filter(Boolean));
  stderrTail.splice(0, Math.max(0, stderrTail.length - 40));
});
const client = new Client({ name: "dimension-browser-bench", version: "0.1.0" });
await client.connect(transport);

async function call(name, args, options) {
  const result = await client.callTool({ name, arguments: args }, undefined, options);
  if (result.isError) {
    const text = result.content?.find((c) => c.type === "text")?.text;
    const error = new Error(`${name} failed: ${result.structuredContent?.error ?? text ?? "unknown error"}`);
    error.structured = result.structuredContent;
    throw error;
  }
  return result.structuredContent;
}

// ---------------------------------------------------------------- run

const runs = [];
const startedAt = new Date();

for (const agent of agents) {
  console.log(`\n## ${agent}`);
  let browserId = null;
  try {
    const state = await call("browser_open", { profile: `bench-${agent}`, engine: opts.engine, url: `${base}/` });
    browserId = state.browserId;
  } catch (error) {
    console.error(`[bench] ${agent}: browser_open failed: ${error.message}`);
    for (const site of sites) runs.push({ agent, site, success: false, seconds: 0, status: "error", error: error.message, stepCount: 0, usage: null });
    continue;
  }

  for (const site of sites) {
    const url = `${base}/${site}`;
    await resetSites();
    const run = { agent, site, url, success: false, seconds: 0, status: "error", stepCount: 0, usage: null, summary: "", error: null, check: null };
    const t0 = performance.now();
    try {
      await call("browser_act", { browserId, action: { kind: "navigate", url: `${base}/` } });
      console.log(`[${agent}/${site}] task started`);
      const progress = { onprogress: (p) => console.log(`[${agent}/${site}] ${p.progress}: ${p.message ?? ""}`), timeout: 60_000 };
      const deadline = performance.now() + taskTimeoutMs;
      let taskRun = await call("browser_task", { browserId, agent, task: taskText(url), maxSteps }, progress);
      while (taskRun.status === "running") {
        if (performance.now() > deadline) throw new Error(`task exceeded ${taskTimeoutMs / 1000}s`);
        taskRun = await call("browser_task_wait", { browserId }, progress);
      }
      Object.assign(run, { status: taskRun.status, stepCount: taskRun.stepCount, usage: taskRun.usage, summary: taskRun.summary, taskMs: taskRun.elapsedMs });
    } catch (error) {
      run.error = error.message;
      run.status = error.structured?.status ?? "error";
      console.error(`[${agent}/${site}] ${error.message}`);
      await call("browser_task_cancel", { browserId }).catch(() => {});
    }
    run.seconds = (performance.now() - t0) / 1000;
    const check = (await siteResults()).sites[site];
    run.check = check;
    run.success = check.success;
    console.log(`[${agent}/${site}] ${run.status} in ${run.seconds.toFixed(1)}s -> ${run.success ? "SUCCESS" : `FAIL (submitted=${check.submitted} missing=[${check.missing}] wrong=[${check.wrong.map((w) => w.field)}])`}`);
    runs.push(run);
  }

  await call("browser_close", { browserId }).catch((error) => console.error(`[bench] ${agent}: browser_close failed: ${error.message}`));
}

await client.close();
sitesServer?.close();

// ---------------------------------------------------------------- report

const tokens = (u) => (u ? u.inputTokens + u.outputTokens : 0);
const lines = [
  "| agent | site | success | seconds | steps | model calls | tokens |",
  "| --- | --- | --- | ---: | ---: | ---: | ---: |",
];
for (const r of runs) {
  lines.push(`| ${r.agent} | ${r.site} | ${r.success ? "yes" : `no (${r.status})`} | ${r.seconds.toFixed(1)} | ${r.stepCount} | ${r.usage?.modelCalls ?? "-"} | ${r.usage ? tokens(r.usage) : "-"} |`);
}
lines.push("", "| agent | success | seconds | steps | model calls | tokens | cost USD |", "| --- | ---: | ---: | ---: | ---: | ---: | ---: |");
for (const agent of agents) {
  const rs = runs.filter((r) => r.agent === agent);
  const sum = (f) => rs.reduce((n, r) => n + f(r), 0);
  const costs = rs.map((r) => r.usage?.costUsd).filter((c) => typeof c === "number");
  lines.push(`| ${agent} | ${rs.filter((r) => r.success).length}/${rs.length} | ${sum((r) => r.seconds).toFixed(1)} | ${sum((r) => r.stepCount)} | ${sum((r) => r.usage?.modelCalls ?? 0)} | ${sum((r) => tokens(r.usage))} | ${costs.length ? costs.reduce((a, b) => a + b, 0).toFixed(4) : "-"} |`);
}
console.log(`\n${lines.join("\n")}`);

const outDir = new URL("./results/", import.meta.url);
await mkdir(outDir, { recursive: true });
const outFile = new URL(`${startedAt.toISOString().replace(/[:.]/g, "-")}.json`, outDir);
await writeFile(outFile, JSON.stringify({ startedAt: startedAt.toISOString(), options: opts, applicant: applicant.email, runs }, null, 2));
console.log(`\nRaw results: ${fileURLToPath(outFile)}`);
if (runs.some((r) => r.error) && stderrTail.length) console.error(`\nMCP server stderr (tail):\n${stderrTail.join("\n")}`);

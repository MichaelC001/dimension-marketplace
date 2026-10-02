// A plain-Node host for the real code worker, driven over stdin/stdout JSON lines by a test: `node node-host.mjs <worker bundle> <tab handle json> [init json]`.
// The product runs the worker as a Node worker thread (`node app/server.mjs`); `bun test` cannot stand in for that where unhandled rejections matter, because the bun test runner ends any
// worker thread that has an unhandled rejection, listeners or not. This starts the bundle in a worker thread, answers the cell's one `open` with the tab the test launched, and reports
// everything the worker says (and how it ends) as one JSON object per line.
import { createInterface } from "node:readline";
import { Worker } from "node:worker_threads";

const [bundle, handleJson, initJson] = process.argv.slice(2);
const handle = JSON.parse(handleJson);
const out = line => process.stdout.write(`${JSON.stringify(line)}\n`);
const worker = new Worker(bundle);
worker.on("message", message => {
  out(message);
  if (message.t === "bridge" && message.request.action === "open") {
    worker.postMessage({ t: "bridge-reply", id: message.id, ok: true, value: { text: 'Opened tab "main"', details: { action: "open", name: "main", url: handle.url }, attach: handle } });
  }
});
worker.on("error", error => out({ t: "worker-error", message: error.message }));
worker.on("exit", code => {
  out({ t: "worker-exit", code });
  process.exit(0);
});
worker.postMessage({ t: "init", session: "s1", env: { PATH: process.env.PATH ?? "" }, ...(initJson ? JSON.parse(initJson) : {}) });
createInterface({ input: process.stdin }).on("line", line => worker.postMessage(JSON.parse(line)));

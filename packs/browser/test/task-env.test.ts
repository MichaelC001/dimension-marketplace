/** WHAT BREAKS IN THE PRODUCT IF THIS GOES RED: a host secret leaves the machine through the jev agent. The task worker is a Python process driven by a model that reads page text an attacker can write, and it can
 *  run code; whatever sits in its environment is one prompt injection from being sent out. The pack server's environment holds more than the pack's own keys (a cloud key, a token the host exported), so the worker is
 *  handed an allow-list: what an interpreter needs to start, plus the two jev keys, and nothing else.
 */
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { z } from "zod";
import { releaseSpare, startWorker, taskWorkerEnv } from "../src/task";

describe("the environment a task worker is handed", () => {
	const SOURCE = {
		FOO_SECRET: "s1",
		AWS_SECRET_ACCESS_KEY: "s2",
		GITHUB_TOKEN: "s3",
		DIMENSION_API_TOKEN: "s4",
		TYPESAFE_API_KEY: "ambient-key",
		PATH: "/bin",
		SystemRoot: "C:\\Windows",
		Temp: "C:\\Temp",
		HOME: "/home/u",
		LANG: "en_US.UTF-8",
		LC_ALL: "C.UTF-8",
		PYTHONPATH: "/lib",
		HTTPS_PROXY: "http://proxy:3128",
		NO_PROXY: "localhost",
		SSL_CERT_FILE: "/etc/ca.pem",
		TEXT_MODEL: "small-model",
		TEXT_MODEL_BASE_URL: "http://models.local/v1",
		TEXT_MODEL_API_KEY: "ambient-text-key",
	};

	test("keeps what an interpreter starts with and leaves every other variable of the host's behind", () => {
		const env = taskWorkerEnv(SOURCE, {});
		expect(env).toEqual({
			PATH: "/bin",
			SystemRoot: "C:\\Windows",
			Temp: "C:\\Temp",
			HOME: "/home/u",
			LANG: "en_US.UTF-8",
			LC_ALL: "C.UTF-8",
			PYTHONPATH: "/lib",
			HTTPS_PROXY: "http://proxy:3128",
			NO_PROXY: "localhost",
			SSL_CERT_FILE: "/etc/ca.pem",
			TEXT_MODEL: "small-model",
			TEXT_MODEL_BASE_URL: "http://models.local/v1",
		});
	});

	test("hands over the jev keys only when they are supplied, never because the host's own environment held one", () => {
		expect(taskWorkerEnv(SOURCE, {})).not.toHaveProperty("TYPESAFE_API_KEY");
		const env = taskWorkerEnv(SOURCE, { TYPESAFE_API_KEY: "sk-a", TEXT_MODEL_API_KEY: "sk-b" });
		expect(env.TYPESAFE_API_KEY).toBe("sk-a");
		expect(env.TEXT_MODEL_API_KEY).toBe("sk-b");
		expect(env).not.toHaveProperty("FOO_SECRET");
		expect(env).not.toHaveProperty("AWS_SECRET_ACCESS_KEY");
	});

	test("what the pack sets for the worker wins over the same name in the host's environment", () => {
		expect(taskWorkerEnv({ PYTHONUNBUFFERED: "0", PATH: "/bin" }, { PYTHONUNBUFFERED: "1" })).toEqual({ PATH: "/bin", PYTHONUNBUFFERED: "1" });
	});
});

const PYTHON_DIR = fileURLToPath(new URL("../python/", import.meta.url));
const PYTHON = process.env.DIM_BROWSER_PYTHON?.trim() || join(PYTHON_DIR, ".venv", ...(process.platform === "win32" ? ["Scripts", "python.exe"] : ["bin", "python"]));
if (!existsSync(PYTHON)) console.warn(`[browser tests] ${PYTHON} is missing; the task worker environment test is SKIPPED. Run: cd python && uv sync --python 3.12 (or set DIM_BROWSER_PYTHON)`);
const describeWithPython = existsSync(PYTHON) ? describe : describe.skip;

/** A worker that speaks the protocol's one line and answers with the environment it was started with (its names, and the two jev keys' values). */
const REPORTING_WORKER = `import json, os, sys

if sys.stdin.readline():
    seen = {"names": sorted(os.environ), "keys": {k: os.environ.get(k, "") for k in ("TYPESAFE_API_KEY", "TEXT_MODEL_API_KEY")}}
    print(json.dumps({"type": "result", "status": "done", "summary": json.dumps(seen), "steps": 0}), flush=True)
`;

const Seen = z.object({ names: z.array(z.string()), keys: z.record(z.string(), z.string()) });

const HOST_ENV = ["DIM_BROWSER_PYTHON", "PYTHONPATH", "PYTHONDONTWRITEBYTECODE", "FOO_SECRET", "AWS_SECRET_ACCESS_KEY", "TYPESAFE_API_KEY", "TEXT_MODEL_API_KEY"] as const;

describeWithPython("a task worker the pack starts", () => {
	const saved: Partial<Record<(typeof HOST_ENV)[number], string>> = {};
	let fakeDir = "";

	beforeAll(async () => {
		for (const name of HOST_ENV) saved[name] = process.env[name];
		// `-m dim_browser_bridge` runs from the pack's python folder, where the real package is: `sitecustomize` (imported by `site`, from PYTHONPATH) binds the fake one first.
		fakeDir = await mkdtemp(join(tmpdir(), "task-env-"));
		await mkdir(join(fakeDir, "dim_browser_bridge"));
		await writeFile(join(fakeDir, "dim_browser_bridge", "__init__.py"), "");
		await writeFile(join(fakeDir, "dim_browser_bridge", "__main__.py"), REPORTING_WORKER);
		await writeFile(join(fakeDir, "sitecustomize.py"), "import dim_browser_bridge  # noqa: F401\n");
		process.env.DIM_BROWSER_PYTHON = PYTHON;
		process.env.PYTHONPATH = fakeDir;
		process.env.PYTHONDONTWRITEBYTECODE = "1";
		process.env.FOO_SECRET = "a-host-secret";
		process.env.AWS_SECRET_ACCESS_KEY = "another-host-secret";
		process.env.TYPESAFE_API_KEY = "sk-jev";
		process.env.TEXT_MODEL_API_KEY = "sk-text";
	});

	afterEach(releaseSpare);

	afterAll(async () => {
		for (const name of HOST_ENV) {
			if (saved[name] === undefined) delete process.env[name];
			else process.env[name] = saved[name];
		}
		await rm(fakeDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
	});

	test("starts with the two jev keys and the interpreter's own settings, and none of the server's other secrets", async () => {
		const worker = startWorker({ cdpUrl: "http://127.0.0.1:1/route", task: "x", maxSteps: 1, startUrl: "about:blank" }, () => undefined);
		const result = await worker.done;
		expect(result.status).toBe("done");
		const seen = Seen.parse(JSON.parse(result.summary));
		// Windows reports variable names in capitals: compare that way everywhere.
		const names = seen.names.map((name) => name.toUpperCase());
		expect(names).not.toContain("FOO_SECRET");
		expect(names).not.toContain("AWS_SECRET_ACCESS_KEY");
		expect(names).toContain("PYTHONPATH");
		expect(names).toContain("PYTHONUNBUFFERED");
		expect(names).toContain("PATH");
		expect(seen.keys).toEqual({ TYPESAFE_API_KEY: "sk-jev", TEXT_MODEL_API_KEY: "sk-text" });
	});
});

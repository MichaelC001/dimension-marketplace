// GPU memory while a job runs, for the asset manifest's provenance (gate Q-01).
//
// Windows (WDDM) hides per-process VRAM from nvidia-smi, so the only honest
// number is the machine's TOTAL GPU memory in use: the baseline just before the
// job and the peak during it. Other programs on the GPU (an editor, a browser)
// are in that number, so the delta is an upper bound — the same measurement the
// lab's `tools/run_cmd.py` took for the bake-off. One long-lived `nvidia-smi`
// loop is read rather than one process per sample.
//
// The first GPU's reading is the baseline and the largest reading from any GPU
// is the peak, which is exact on the single-GPU machine this pack runs on.

import { spawn } from "node:child_process";

/** How long the first reading may take before there is taken to be no GPU data. */
const FIRST_SAMPLE_TIMEOUT_MS = 5_000;

const SAMPLE_INTERVAL_MS = 1_000;

export interface VramReading {
	readonly baselineMiB: number;
	readonly peakMiB: number;
}

export interface VramSampler {
	/** Stop sampling and return what was seen. */
	stop(): VramReading;
}

/** Start sampling, or resolve undefined when `nvidia-smi` is missing or silent. */
export async function startVramSampler(): Promise<VramSampler | undefined> {
	const child = spawn(
		"nvidia-smi",
		["--query-gpu=memory.used", "--format=csv,noheader,nounits", `--loop-ms=${SAMPLE_INTERVAL_MS}`],
		{ windowsHide: true, stdio: ["ignore", "pipe", "ignore"] },
	);
	const first = Promise.withResolvers<VramSampler | undefined>();
	let baseline: number | undefined;
	let peak = 0;
	let pending = "";

	const sampler: VramSampler = {
		stop() {
			child.kill();
			return { baselineMiB: baseline ?? 0, peakMiB: peak };
		},
	};
	const timer = setTimeout(() => {
		child.kill();
		first.resolve(undefined);
	}, FIRST_SAMPLE_TIMEOUT_MS);
	child.once("error", () => first.resolve(undefined));
	child.once("exit", () => first.resolve(undefined));
	child.stdout?.on("data", (chunk: Buffer) => {
		pending += chunk.toString("utf8");
		const lines = pending.split("\n");
		pending = lines.pop() ?? "";
		for (const line of lines) {
			const used = Number.parseInt(line, 10);
			if (!Number.isFinite(used)) continue;
			peak = Math.max(peak, used);
			if (baseline === undefined) {
				baseline = used;
				first.resolve(sampler);
			}
		}
	});
	try {
		return await first.promise;
	} finally {
		clearTimeout(timer);
	}
}

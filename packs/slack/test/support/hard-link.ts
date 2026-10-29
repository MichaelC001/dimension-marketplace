import { link, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const canHardLink = await (async () => {
	const probe = await mkdtemp(join(tmpdir(), "slack-hard-link-probe-"));
	try {
		await writeFile(join(probe, "target"), "x");
		await link(join(probe, "target"), join(probe, "alias"));
		return true;
	} catch {
		return false;
	} finally {
		await rm(probe, { recursive: true, force: true });
	}
})();

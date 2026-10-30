import type { ShareSummary } from "./types";

/** A hosted link whose file changed after its last version. A link from this computer follows the file by itself. */
export function fileChanged(share: Pick<ShareSummary, "host" | "versionAt">, mtimeMs: number): boolean {
	return share.host !== "p2p" && mtimeMs > share.versionAt;
}

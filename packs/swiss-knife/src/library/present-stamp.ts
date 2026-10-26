import { resolve } from "node:path";
import type { PresentDetails } from "../present";
import { errorMessage } from "./errors";
import type { Library } from "./types";

export interface PresentSession {
	readonly cwd: string;
	readonly sessionId: string;
}

export async function stampPresented(library: Library, details: PresentDetails, session: PresentSession): Promise<void> {
	const workspace = resolve(session.cwd);
	for (const item of details.presentation.items) {
		const image = item.thumb === undefined ? undefined : details.images?.[item.thumb];
		const thumbMime = image?.mimeType === "image/png" || image?.mimeType === "image/jpeg" ? image.mimeType : undefined;
		try {
			await library.stamp({
				path: item.path,
				source: "present",
				workspace,
				sessionId: session.sessionId,
				...(item.width === undefined ? {} : { width: item.width }),
				...(item.height === undefined ? {} : { height: item.height }),
				...(image === undefined || thumbMime === undefined ? {} : { thumb: { bytes: Buffer.from(image.data, "base64"), mime: thumbMime } }),
			});
		} catch (error) {
			console.error(`library: ${item.name} was presented but not indexed: ${errorMessage(error)}`);
		}
	}
}

import { loadPeaks, type MediaPlayer, type PeakSource } from "@dimension/mcp-app-kit/media";
import { usePeaks } from "@dimension/mcp-app-kit/media/react";
import type { App } from "@modelcontextprotocol/ext-apps";
import { loadDocumentBytes, loadDocumentHead } from "./document-bytes";
import type { DocTab } from "./tabs";

export type PeaksLoader = typeof loadPeaks;

function tabPeakSource(app: App, tab: DocTab): PeakSource {
	return {
		head: (bytes, signal) => loadDocumentHead(app, tab, bytes, signal),
		whole: async signal => (await loadDocumentBytes(app, tab, { signal })).bytes,
	};
}

export function useWaveform(app: App, tab: DocTab, startable: boolean, player: MediaPlayer, load: PeaksLoader = loadPeaks): Float32Array | undefined {
	return usePeaks({
		id: `${tab.key}\u0000${tab.size}:${tab.mtimeMs}`,
		bytes: tab.size,
		startable,
		player,
		load: (signal, duration) => load(tabPeakSource(app, tab), duration, signal),
	});
}

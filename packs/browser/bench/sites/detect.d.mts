export interface DetectRow {
	id: string;
	group: string;
	/** A bot-detection check would flag this signal. */
	tell: boolean;
	value: string;
	note: string;
}
export interface DetectServer {
	url: string;
	/** The rows the last visit posted; null until it did. */
	rows(): DetectRow[] | null;
	/** The row that needs the driver to have acted first; null until the page posted it. */
	late(): DetectRow | null;
	/** How many times the page has posted the late row since `reset`. */
	lates(): number;
	reset(): void;
	stop(): Promise<void>;
}
export const DETECT_HTML: string;
export function createDetectServer(options?: { port?: number }): Promise<DetectServer>;

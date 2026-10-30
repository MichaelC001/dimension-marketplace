export interface RevisionSpan {
	readonly before: string;
	readonly after: string;
}

export function revisionMarker(own: number, foreign: number): string {
	return `${own}:${foreign}`;
}

function foreignOf(marker: string): string {
	return marker.slice(marker.indexOf(":") + 1);
}

export function isOwnWrite(span: RevisionSpan, last: string | undefined): boolean {
	return span.before === last && foreignOf(span.before) === foreignOf(span.after);
}

export function spanOf(content: unknown): RevisionSpan | undefined {
	if (typeof content !== "object" || content === null || !("revision" in content)) return undefined;
	const { revision } = content;
	if (typeof revision !== "object" || revision === null || !("before" in revision) || !("after" in revision)) return undefined;
	const { before, after } = revision;
	return typeof before === "string" && typeof after === "string" ? { before, after } : undefined;
}

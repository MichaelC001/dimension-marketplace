export type CursorKey = string | number | null;

export interface CursorPosition {
	readonly ordering: string;
	readonly key: CursorKey;
	readonly id: string;
}

export function encodeCursor(position: CursorPosition): string {
	return Buffer.from(JSON.stringify([position.ordering, position.key, position.id])).toString("base64url");
}

export function decodeCursor(text: string, ordering: string): CursorPosition {
	const refusal = new RangeError("the page cursor is not valid for this query");
	let parsed: unknown;
	try {
		parsed = JSON.parse(Buffer.from(text, "base64url").toString("utf8"));
	} catch {
		throw refusal;
	}
	if (!Array.isArray(parsed) || parsed.length !== 3) throw refusal;
	const [cursorOrdering, key, id] = parsed;
	if (cursorOrdering !== ordering || typeof id !== "string") throw refusal;
	if (key !== null && typeof key !== "string" && typeof key !== "number") throw refusal;
	return { ordering, key, id };
}

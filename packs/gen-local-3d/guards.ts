// The one JSON-object guard this pack uses. The connect form's config file,
// `models.json`, a job reference read back after a restart, `result.json` and a
// GLB's JSON chunk are data the pack does not control, so every consumer narrows
// with `isRecord` and then checks only the fields it reads.

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

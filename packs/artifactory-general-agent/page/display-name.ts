export const DISPLAY_NAME_MAX_LENGTH = 48;

export function displayNameToWrite(typed: string | null, override: string | undefined): string | undefined {
	if (typed === null) return undefined;
	const next = typed.replace(/\s+/g, " ").trim();
	return next === (override ?? "") ? undefined : next;
}

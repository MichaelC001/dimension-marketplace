export class LibraryError extends Error {
	override readonly name = "LibraryError";
}

export function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export function hasCode(error: unknown, ...codes: readonly string[]): boolean {
	return error instanceof Error && "code" in error && typeof error.code === "string" && codes.includes(error.code);
}

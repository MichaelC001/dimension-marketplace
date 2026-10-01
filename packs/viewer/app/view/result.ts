// A `view_file` tool result, read as the action it stands for. The result is the
// only thing the host hands this View, so it is parsed at the boundary: a result
// that is not ours (or a server older than this View) opens nothing and says so.
import { ANNOTATE_META_KEY, TAB_META_KEY, tabMetaSchema, viewedFileSchema } from "../../src/contract";
import type { OpenFailureText, ViewerAction } from "./tabs";

interface ResultLike {
	readonly isError?: boolean;
	readonly content?: readonly { readonly type: string; readonly text?: string }[];
	readonly structuredContent?: unknown;
	readonly _meta?: Readonly<Record<string, unknown>>;
}

/**
 * What a file that would not open is told in. The server's text for it is written for the model and carries the
 * engine's own words (`EBUSY: resource busy or locked, open '...' (EBUSY)`) and the path twice; the human is told
 * the one thing that matters, and what to do next. The model still gets the server's text untouched.
 */
const SENTENCES = {
	busy: { message: "Another program has this file open or locked; close it there, then open it here again.", copyPath: false },
	denied: { message: "The viewer is not allowed to read this file; check who may open it, or copy its path to open it another way.", copyPath: true },
	gone: { message: "This file is no longer where it was; it may have been moved, renamed or deleted.", copyPath: false },
	tooLarge: { message: "This file is too large for the viewer to read; copy its path to open it in another program.", copyPath: true },
	notAFile: { message: "This is a folder or a special file, not a document; ask for a file inside it instead.", copyPath: false },
} as const satisfies Record<string, OpenFailureText>;

/** The first match wins: a locked file is also "not permitted" on some systems, and the lock is what to tell. */
const CAUSES: readonly (readonly [RegExp, OpenFailureText])[] = [
	[/\b(?:EBUSY|EAGAIN|ETXTBSY|ENFILE|EMFILE)\b|resource busy or locked|used by another process/i, SENTENCES.busy],
	[/\b(?:EACCES|EPERM)\b|permission denied|operation not permitted|access is denied/i, SENTENCES.denied],
	[/\b(?:ENOENT|ENOTDIR)\b|no such file|not found/i, SENTENCES.gone],
	[/\b(?:ERR_FS_FILE_TOO_LARGE|EFBIG)\b|greater than 2 GiB|too large/i, SENTENCES.tooLarge],
	[/\bEISDIR\b|not a regular file|illegal operation on a directory/i, SENTENCES.notAFile],
];

/**
 * The file an error names: the first absolute path in double quotes (every message of the server's puts it there). A
 * quoted word that is not a path (a tool's name in the host's own words) names no file, and a relative path is one the
 * server refused as it stood, so there is no file to hold a tab for.
 */
const QUOTED_PATH = /"((?:[A-Za-z]:[\\/]|\\\\|\/)[^"\r\n]*)"/;

/**
 * An error result of `view_file` as the human should read it. A cause the viewer knows becomes one plain sentence;
 * anything else (the fence's own refusals are sentences already) is kept as the server wrote it.
 */
export function describeOpenFailure(text: string): { readonly failure: OpenFailureText; readonly path?: string } {
	const path = QUOTED_PATH.exec(text)?.[1];
	// The causes are read from the words around the paths, never from the paths: a folder called "permission denied" is not a refusal.
	const words = text.replace(/"[^"]*"|'[^']*'/g, "");
	const known = CAUSES.find(([pattern]) => pattern.test(words));
	const failure = known?.[1] ?? { message: text === "" ? "The file could not be opened." : text, copyPath: false };
	return path === undefined ? { failure } : { failure, path };
}

export function actionFromResult(result: ResultLike): ViewerAction {
	if (result.isError) {
		const text = (result.content ?? []).map(block => (block.type === "text" ? (block.text ?? "") : "")).join("\n").trim();
		return { type: "failed", ...describeOpenFailure(text) };
	}
	const file = viewedFileSchema.safeParse(result.structuredContent);
	if (!file.success) return { type: "refused", message: "The viewer server answered with something this View does not understand." };
	// The key the server named for the host's tab when it sent one (today it is the path); the path otherwise.
	const tab = tabMetaSchema.safeParse(result._meta?.[TAB_META_KEY]);
	return { type: "open", key: tab.success ? tab.data.key : file.data.path, file: file.data, ...(result._meta?.[ANNOTATE_META_KEY] === true ? { annotate: true } : {}) };
}

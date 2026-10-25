import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { randomBytes } from "node:crypto";
import type { z } from "zod";

export class StoredFileError extends Error {
	override readonly name = "StoredFileError";
}

export async function readJsonFile<S extends z.ZodType>(path: string, schema: S): Promise<z.infer<S> | undefined> {
	let text: string;
	try {
		text = await readFile(path, "utf8");
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
		throw error;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		throw new StoredFileError(`${path} is not valid JSON`);
	}
	const checked = schema.safeParse(parsed);
	if (!checked.success) {
		const issue = checked.error.issues[0];
		throw new StoredFileError(`${path} is not valid: ${issue?.path.join(".") || "(root)"} ${issue?.message ?? ""}`.trim());
	}
	return checked.data;
}

export async function writePrivateJsonFile(path: string, value: unknown): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	const staged = `${path}.${randomBytes(6).toString("hex")}.tmp`;
	try {
		await writeFile(staged, `${JSON.stringify(value, null, "\t")}\n`, { mode: 0o600 });
		await rename(staged, path);
	} catch (error) {
		await rm(staged, { force: true });
		throw error;
	}
}

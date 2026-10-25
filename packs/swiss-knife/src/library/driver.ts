import { chmod, open } from "node:fs/promises";
import { hasCode } from "./errors";

export type SqlValue = string | number | bigint | null | Uint8Array;

export interface SqlRun {
	readonly changes: number;
}

export interface SqlStatement {
	all<Row>(...params: readonly SqlValue[]): Row[];
	get<Row>(...params: readonly SqlValue[]): Row | undefined;
	run(...params: readonly SqlValue[]): SqlRun;
	finalize(): void;
}

export interface SqlDriver {
	exec(sql: string): void;
	prepare(sql: string): SqlStatement;
	close(): void;
}

interface NativeStatement {
	all(...params: SqlValue[]): unknown[];
	get(...params: SqlValue[]): unknown;
	run(...params: SqlValue[]): { readonly changes: number | bigint };
	finalize?(): void;
}

interface NativeDatabase {
	exec(sql: string): unknown;
	prepare(sql: string): NativeStatement;
	close(): void;
}

function adapt(db: NativeDatabase): SqlDriver {
	return {
		exec: sql => db.exec(sql),
		prepare(sql) {
			const statement = db.prepare(sql);
			return {
				all<Row>(...params: readonly SqlValue[]) {
					return statement.all(...params) as Row[];
				},
				get<Row>(...params: readonly SqlValue[]) {
					return (statement.get(...params) ?? undefined) as Row | undefined;
				},
				run: (...params) => ({ changes: Number(statement.run(...params).changes) }),
				finalize: () => statement.finalize?.(),
			};
		},
		close: () => db.close(),
	};
}

const PRIVATE_FILE_MODE = 0o600;
const DATABASE_FILE_SUFFIXES = ["", "-wal", "-shm"] as const;

export async function openDriver(file: string): Promise<SqlDriver> {
	if (process.platform !== "win32") await (await open(file, "a", PRIVATE_FILE_MODE)).close();
	if (typeof Bun !== "undefined") {
		const { Database } = await import("bun:sqlite");
		return adapt(new Database(file, { create: true }));
	}
	const { DatabaseSync } = await import("node:sqlite");
	return adapt(new DatabaseSync(file));
}

export async function restrictDatabaseFiles(file: string): Promise<void> {
	if (process.platform === "win32") return;
	for (const suffix of DATABASE_FILE_SUFFIXES) {
		try {
			await chmod(file + suffix, PRIVATE_FILE_MODE);
		} catch (error) {
			if (!hasCode(error, "ENOENT")) throw error;
		}
	}
}

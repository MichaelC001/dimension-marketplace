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

export async function openDriver(file: string): Promise<SqlDriver> {
	if (typeof Bun !== "undefined") {
		const { Database } = await import("bun:sqlite");
		const db = new Database(file, { create: true });
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
					run: (...params) => ({ changes: statement.run(...params).changes }),
					finalize: () => statement.finalize(),
				};
			},
			close: () => db.close(),
		};
	}
	const { DatabaseSync } = await import("node:sqlite");
	const db = new DatabaseSync(file);
	return {
		exec: sql => db.exec(sql),
		prepare(sql) {
			const statement = db.prepare(sql);
			return {
				all<Row>(...params: readonly SqlValue[]) {
					return statement.all(...params) as Row[];
				},
				get<Row>(...params: readonly SqlValue[]) {
					return statement.get(...params) as Row | undefined;
				},
				run: (...params) => ({ changes: Number(statement.run(...params).changes) }),
				finalize: () => undefined,
			};
		},
		close: () => db.close(),
	};
}

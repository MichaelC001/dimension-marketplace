import { describe, expect, test } from "bun:test";
import type { App } from "@modelcontextprotocol/ext-apps";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { RevisionSpan } from "../../src/library/revision";
import { createLibraryTools, type LibraryTools } from "../app/view/library/library-tools";

const span: RevisionSpan = { before: "4:7", after: "5:7" };
const ITEM = { id: "a", name: "a.png" };

const answering = (structuredContent: Record<string, unknown>): App =>
	({ callServerTool: async (): Promise<CallToolResult> => ({ content: [], structuredContent }), sendMessage: async () => ({}) }) as unknown as App;

const heard = (tools: LibraryTools): RevisionSpan[] => {
	const spans: RevisionSpan[] = [];
	tools.onWrite(each => void spans.push(each));
	return spans;
};

describe("a write the View makes tells its listeners the span of the change it made", () => {
	const writes: readonly { readonly name: string; readonly answer: Record<string, unknown>; readonly write: (tools: LibraryTools) => Promise<unknown> }[] = [
		{ name: "update", answer: { item: ITEM }, write: tools => tools.update("a", { starred: true }) },
		{ name: "setThumb", answer: { ok: true }, write: tools => tools.setThumb("a", "AAAA", "image/png") },
		{ name: "markRead", answer: {}, write: tools => tools.markRead(["c1"]) },
		{ name: "open", answer: { path: "/work/a.png" }, write: tools => tools.open("a") },
	];

	for (const each of writes) {
		test(`${each.name}: the span in the server's answer reaches the listener, once`, async () => {
			const tools = createLibraryTools(answering({ ...each.answer, revision: span }));
			const spans = heard(tools);

			await each.write(tools);

			expect(spans).toStrictEqual([span]);
		});
	}

	const malformed: readonly { readonly name: string; readonly answer: Record<string, unknown> }[] = [
		{ name: "no revision at all", answer: { item: ITEM } },
		{ name: "a bare marker where the span should be", answer: { item: ITEM, revision: "5:7" } },
		{ name: "a span without its after", answer: { item: ITEM, revision: { before: "4:7" } } },
		{ name: "a span whose after is not text", answer: { item: ITEM, revision: { before: "4:7", after: 5 } } },
		{ name: "a null revision", answer: { item: ITEM, revision: null } },
	];

	for (const each of malformed) {
		test(`an answer with ${each.name} calls nobody, and the write still answers`, async () => {
			const tools = createLibraryTools(answering(each.answer));
			const spans = heard(tools);

			const updated: unknown = await tools.update("a", { starred: true });
			expect(updated).toEqual(ITEM);

			expect(spans).toHaveLength(0);
		});
	}

	test("what the caller gets back is what the server answered: update the item, open the whole result with its span", async () => {
		const tools = createLibraryTools(answering({ item: ITEM, revision: span }));

		const updated: unknown = await tools.update("a", { starred: true });
		expect(updated).toEqual(ITEM);
		expect((await tools.open("a")).structuredContent).toEqual({ item: ITEM, revision: span });
	});

	test("every listener hears each write, and one that unsubscribed hears no more while the others still do", async () => {
		const tools = createLibraryTools(answering({ item: ITEM, revision: span }));
		const first: RevisionSpan[] = [];
		const second: RevisionSpan[] = [];
		const stopFirst = tools.onWrite(each => void first.push(each));
		tools.onWrite(each => void second.push(each));

		await tools.update("a", { starred: true });
		expect(first).toStrictEqual([span]);
		expect(second).toStrictEqual([span]);

		stopFirst();
		await tools.update("a", { starred: false });
		expect(first).toStrictEqual([span]);
		expect(second).toStrictEqual([span, span]);
	});
});

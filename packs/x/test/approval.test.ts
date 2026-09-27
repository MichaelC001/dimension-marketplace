// Public, unretractable X writes (post, thread, DM, delete) must stop for a human
// click in EVERY approval mode, yolo included — a bare "write" tier is
// auto-approved there. The gate is decided by the engine's own `resolveApproval`
// (the pack's `@oh-my-pi/pi-coding-agent` peer), fed the tool exactly as the
// default-exported factory registers it. The approval card is what the human
// reads before clicking, so it must carry everything that goes out, verbatim.

import { expect, test } from "bun:test";
import { resolveApproval } from "@oh-my-pi/pi-coding-agent/tools/approval";
import xExtension from "../index";

interface RegisteredTool {
	name: string;
	approval?: unknown;
	formatApprovalDetails?: (args: unknown) => string[];
}

const tools = new Map<string, RegisteredTool>();
xExtension({
	registerTool(tool: RegisteredTool) {
		tools.set(tool.name, tool);
	},
} as unknown as Parameters<typeof xExtension>[0]);

function tool(name: string): RegisteredTool {
	const found = tools.get(name);
	if (!found) throw new Error(`x extension did not register ${name}`);
	return found;
}

function card(name: string, args: unknown): string {
	const format = tool(name).formatApprovalDetails;
	if (!format) throw new Error(`${name} has no approval card`);
	return format(args).join("\n");
}

const yolo = (name: string, args: unknown) =>
	resolveApproval(tool(name) as Parameters<typeof resolveApproval>[0], args, "yolo").policy;

test("publishing, deleting and DMing prompt the human even in yolo mode", () => {
	expect(yolo("x_post", { text: "shipping today" })).toBe("prompt");
	expect(yolo("x_post", { text: "agreed", replyTo: "1790000000000000000" })).toBe("prompt");
	expect(yolo("x_thread", { posts: ["one", "two"] })).toBe("prompt");
	expect(yolo("x_dm", { username: "@someone", text: "hi" })).toBe("prompt");
	expect(yolo("x_delete", { post: "1790000000000000000" })).toBe("prompt");
});

test("a private bookmark stays auto-approved in yolo mode", () => {
	expect(yolo("x_bookmark", { post: "1790000000000000000" })).toBe("allow");
});

test("the x_post card shows the whole text, untruncated, and the post it replies to", () => {
	const text = `${"long form update, every word matters. ".repeat(10)}END-OF-POST`;
	expect(text.length).toBeGreaterThan(280);
	const shown = card("x_post", { text, replyTo: "https://x.com/someone/status/1790000000000000001" });
	expect(shown).toContain(text);
	expect(shown).toContain("1790000000000000001");
});

test("the x_thread card lists every post, in publishing order", () => {
	const posts = ["first: the setup", "second: the turn", "third: the payoff"];
	const shown = card("x_thread", { posts });
	const positions = posts.map(post => shown.indexOf(post));
	expect(positions.every(at => at >= 0)).toBe(true);
	expect(positions).toEqual([...positions].sort((a, b) => a - b));
});

test("the x_dm card names the recipient and carries the full message", () => {
	const shown = card("x_dm", { username: "@recipient_handle", text: "the exact private message body" });
	expect(shown).toContain("@recipient_handle");
	expect(shown).toContain("the exact private message body");
});

test("malformed args still render a card instead of throwing", () => {
	for (const name of ["x_post", "x_thread", "x_dm", "x_delete"]) {
		for (const args of [undefined, 42, { text: 7 }, { posts: [1, null] }]) {
			expect(card(name, args)).toContain("As:");
		}
	}
});

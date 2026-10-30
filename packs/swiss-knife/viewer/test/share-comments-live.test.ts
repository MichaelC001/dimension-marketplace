import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { createElement } from "react";
import type { ShareSummary } from "../../src/library/types";
import type { LibraryTools, ShareComment } from "../app/view/library/library-tools";
import type * as CommentsModule from "../app/view/library/share-comments";
import { mapKitReact } from "./kit-react";
import { installReact, type ReactEnv } from "./media-react";

mapKitReact();

let env: ReactEnv;
let comments: typeof CommentsModule;
let latest: CommentsModule.ArtifactComments | undefined;
let served: ShareComment[];
let fetches: number;

const share = (unread: number, commentCount: number): ShareSummary => ({
	id: "s1",
	host: "p2p",
	url: "https://relay.example/a/s1",
	audience: { kind: "link" },
	version: 1,
	versionAt: 1,
	allowComments: true,
	comments: commentCount,
	unread,
});

const said = (id: string): ShareComment => ({ id, shareId: "s1", author: "Ana", body: `body ${id}`, version: 1, createdAt: 5, shareUrl: "https://relay.example/a/s1" });

const tools = {
	comments: async (): Promise<readonly ShareComment[]> => {
		fetches += 1;
		return [...served];
	},
} as unknown as LibraryTools;

function Probe({ shares }: { readonly shares: readonly ShareSummary[] }): null {
	latest = comments.useArtifactComments({ tools, artifactId: "a1", shares, now: 10, onShares: () => undefined });
	return null;
}

beforeAll(async () => {
	env = await installReact();
	comments = await import("../app/view/library/share-comments");
});

beforeEach(() => {
	latest = undefined;
	served = [];
	fetches = 0;
});

afterEach(() => env.cleanup());
afterAll(() => env.restore());

const settle = () =>
	env.act(async () => {
		for (let turn = 0; turn < 8; turn += 1) await Promise.resolve();
	});

const bodies = (): string[] => (latest?.comments ?? []).map(each => each.body);

describe("the comments of an open artifact follow its share counts", () => {
	test("a first comment that arrives after the panel opened is fetched and listed", async () => {
		const view = await env.mount(createElement(Probe, { shares: [share(0, 0)] }));
		await settle();
		expect(bodies()).toEqual([]);
		expect(latest?.threads).toHaveLength(0);

		served = [said("c1")];
		await view.render(createElement(Probe, { shares: [share(1, 1)] }));
		await settle();

		expect(fetches).toBe(2);
		expect(bodies()).toEqual(["body c1"]);
		expect(latest?.threads).toHaveLength(1);
	});

	test("a comment that arrives while others were already unread is fetched too", async () => {
		served = [said("c1"), said("c2")];
		const view = await env.mount(createElement(Probe, { shares: [share(2, 2)] }));
		await settle();
		expect(bodies()).toEqual(["body c1", "body c2"]);

		served = [said("c1"), said("c2"), said("c3")];
		await view.render(createElement(Probe, { shares: [share(3, 3)] }));
		await settle();

		expect(fetches).toBe(2);
		expect(bodies()).toEqual(["body c1", "body c2", "body c3"]);
	});

	test("a comment that arrives already read, so the unread count did not move, is fetched too", async () => {
		served = [said("c1"), said("c2")];
		const view = await env.mount(createElement(Probe, { shares: [share(1, 2)] }));
		await settle();

		served = [said("c1"), said("c2"), said("c3")];
		await view.render(createElement(Probe, { shares: [share(1, 3)] }));
		await settle();

		expect(fetches).toBe(2);
		expect(bodies()).toEqual(["body c1", "body c2", "body c3"]);
	});

	test("a refreshed item that says the same thing fetches nothing again", async () => {
		served = [said("c1"), said("c2")];
		const view = await env.mount(createElement(Probe, { shares: [share(1, 2)] }));
		await settle();
		for (let refreshes = 0; refreshes < 3; refreshes += 1) {
			await view.render(createElement(Probe, { shares: [share(1, 2)] }));
			await settle();
		}

		expect(fetches).toBe(1);
	});
});

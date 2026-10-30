import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { createElement } from "react";
import type { ShareSummary } from "../../src/library/types";
import type { LibraryTools } from "../app/view/library/library-tools";
import { AccessList, type AccessListProps } from "../app/view/library/share-list";
import { installReact, type ReactEnv } from "./media-react";

let env: ReactEnv;

beforeAll(async () => {
	env = await installReact();
});
afterEach(() => env.cleanup());
afterAll(() => env.restore());

const NOW = 10;
const MTIME = 1_000;
const NOTICE_TEXT = "The file changed since you shared it.";
const ROW = '[data-slot="library-share-row"]';
const NOTICE = '[data-slot="library-share-outdated"]';
const ALERT = '[role="alert"]';

const share = (id: string, host: string, versionAt: number, over: Partial<ShareSummary> = {}): ShareSummary => ({
	id,
	host,
	url: host === "p2p" ? `https://relay.example/a/${id}` : `https://${host}.example/s/${id}`,
	audience: { kind: "link" },
	version: 1,
	versionAt,
	allowComments: false,
	comments: 0,
	unread: 0,
	...over,
});

const reissued = (from: ShareSummary): ShareSummary => ({ ...from, version: from.version + 1, versionAt: MTIME + 50 });

type Reply = (share: ShareSummary, attempt: number) => Promise<ShareSummary>;

function fakeTools(known: readonly ShareSummary[], reply: Reply = async found => reissued(found)) {
	const asked: string[] = [];
	const newVersion = (shareId: string): Promise<ShareSummary> => {
		asked.push(shareId);
		const found = known.find(each => each.id === shareId);
		if (found === undefined) return Promise.reject(new Error(`no share ${shareId}`));
		return reply(found, asked.length);
	};
	return { tools: { newVersion } as unknown as LibraryTools, asked };
}

function last<T>(list: readonly T[]): T {
	const value = list.at(-1);
	if (value === undefined) throw new Error("nothing was recorded");
	return value;
}

async function show(shares: readonly ShareSummary[], tools: LibraryTools = fakeTools(shares).tools) {
	const recorded: (readonly ShareSummary[])[] = [];
	const props = (current: readonly ShareSummary[]): AccessListProps => ({
		tools,
		shares: current,
		now: NOW,
		mtimeMs: MTIME,
		canShare: true,
		onShare: () => undefined,
		onManage: () => undefined,
		onShares: next => void recorded.push(next),
	});
	const { container, render } = await env.mount(createElement(AccessList, props(shares)));
	return { container, recorded, parentShows: (current: readonly ShareSummary[]) => render(createElement(AccessList, props(current))) };
}

const rowsOf = (container: Element): Element[] => [...container.querySelectorAll(ROW)];
const noticeOf = (row: Element): string | undefined => row.querySelector(NOTICE)?.textContent?.trim();
const updateOf = (row: Element): HTMLButtonElement | undefined => [...row.querySelectorAll("button")].find(button => button.textContent?.includes("Update link"));
const noticesIn = (container: Element): (string | undefined)[] => rowsOf(container).map(noticeOf);

function press(button: HTMLButtonElement | undefined): Promise<void> {
	if (button === undefined) throw new Error("there is no Update link to press");
	const window = env.document.defaultView as Window & typeof globalThis;
	return env.act(async () => void button.dispatchEvent(new window.Event("click", { bubbles: true, cancelable: true })));
}

function rowAt(container: Element, index: number): Element {
	const row = rowsOf(container)[index];
	if (row === undefined) throw new Error(`no row ${index}`);
	return row;
}

describe("a link whose file changed says so on the Share tab", () => {
	test.each<[string, ShareSummary, boolean]>([
		["a Dimension cloud link sealed before the file changed", share("s1", "cloud", MTIME - 1), true],
		["a link on your own server sealed before the file changed", share("s1", "files", MTIME - 1), true],
		["a hosted link sealed at the very moment of the file's last change", share("s1", "cloud", MTIME), false],
		["a hosted link sealed after the file's last change", share("s1", "cloud", MTIME + 1), false],
		["a link from this computer, whatever the times, because it serves the file as it is now", share("s1", "p2p", 0), false],
	])("%s", async (_what, only, outdated) => {
		const { container } = await show([only]);
		const row = rowAt(container, 0);
		expect(noticeOf(row)).toBe(outdated ? NOTICE_TEXT : undefined);
		expect(updateOf(row) !== undefined).toBe(outdated);
	});

	test("a stopped or expired link has nothing to update, however old its version", async () => {
		const { container } = await show([share("live", "cloud", MTIME), share("gone", "cloud", 0, { revokedAt: NOW - 5 }), share("lapsed", "files", 0, { expiresAt: NOW - 1 })]);
		expect(rowsOf(container)).toHaveLength(1);
		expect(container.querySelector(NOTICE)).toBeNull();
		expect([...container.querySelectorAll("button")].some(button => button.textContent?.includes("Update link"))).toBe(false);
	});
});

describe("Update link", () => {
	test("re-seals the one link asked, hands the parent the whole list with only that link replaced, and the notice is gone once the parent shows it", async () => {
		const mine = share("mine", "p2p", 0);
		const stale = share("stale", "cloud", MTIME - 1);
		const gone = share("gone", "cloud", 0, { revokedAt: NOW - 5 });
		const fresh = share("fresh", "files", MTIME + 5);
		const list = [mine, stale, gone, fresh];
		const { tools, asked } = fakeTools(list);
		const { container, recorded, parentShows } = await show(list, tools);

		await press(updateOf(rowAt(container, 1)));

		expect(asked).toEqual(["stale"]);
		expect(recorded).toHaveLength(1);
		expect(last(recorded)).toEqual([mine, reissued(stale), gone, fresh]);

		await parentShows(last(recorded));
		expect(rowsOf(container)).toHaveLength(3);
		expect(noticesIn(container)).toEqual([undefined, undefined, undefined]);
		expect([...container.querySelectorAll("button")].some(button => button.textContent?.includes("Update link"))).toBe(false);
		expect(asked).toEqual(["stale"]);
	});

	test("while the host is re-sealing, the button is busy and a second press starts nothing; it is free again afterwards", async () => {
		const stale = share("stale", "cloud", MTIME - 1);
		let settle: (value: ShareSummary) => void = () => undefined;
		const pending = new Promise<ShareSummary>(resolve => {
			settle = resolve;
		});
		const { tools, asked } = fakeTools([stale], () => pending);
		const { container, recorded } = await show([stale], tools);

		await press(updateOf(rowAt(container, 0)));
		expect(updateOf(rowAt(container, 0))?.getAttribute("aria-busy")).toBe("true");
		await press(updateOf(rowAt(container, 0)));
		expect(asked).toEqual(["stale"]);

		await env.act(async () => settle(reissued(stale)));
		expect(recorded).toHaveLength(1);
		expect(updateOf(rowAt(container, 0))?.getAttribute("aria-busy")).toBeNull();
	});

	test("a refusal from the host shows in the alert, tells the parent nothing, and leaves the link ready to be updated again", async () => {
		const stale = share("stale", "cloud", MTIME - 1);
		const { tools, asked } = fakeTools([stale], () => Promise.reject(new Error("The share server is unreachable")));
		const { container, recorded } = await show([stale], tools);
		expect(container.querySelector(ALERT)).toBeNull();

		await press(updateOf(rowAt(container, 0)));

		expect(container.querySelector(ALERT)?.textContent).toBe("The share server is unreachable");
		expect(recorded).toHaveLength(0);
		expect(noticeOf(rowAt(container, 0))).toBe(NOTICE_TEXT);
		const again = updateOf(rowAt(container, 0));
		expect(again?.getAttribute("aria-busy")).toBeNull();
		expect(again?.hasAttribute("disabled")).toBe(false);
		expect(asked).toEqual(["stale"]);
	});

	test("a retry that works clears the earlier refusal", async () => {
		const stale = share("stale", "cloud", MTIME - 1);
		const { tools, asked } = fakeTools([stale], (found, attempt) => (attempt === 1 ? Promise.reject(new Error("The share server is unreachable")) : Promise.resolve(reissued(found))));
		const { container, recorded } = await show([stale], tools);

		await press(updateOf(rowAt(container, 0)));
		expect(container.querySelector(ALERT)).not.toBeNull();
		await press(updateOf(rowAt(container, 0)));

		expect(container.querySelector(ALERT)).toBeNull();
		expect(asked).toEqual(["stale", "stale"]);
		expect(last(recorded)).toEqual([reissued(stale)]);
	});

	test("with two outdated links, updating one leaves the other's notice in place until it is updated too", async () => {
		const first = share("first", "cloud", MTIME - 1);
		const second = share("second", "files", MTIME - 2, { audience: { kind: "signin", emails: ["pat@example.com"] } });
		const { tools, asked } = fakeTools([first, second]);
		const { container, recorded, parentShows } = await show([first, second], tools);
		expect(noticesIn(container)).toEqual([NOTICE_TEXT, NOTICE_TEXT]);

		await press(updateOf(rowAt(container, 1)));
		expect(asked).toEqual(["second"]);
		expect(last(recorded)).toEqual([first, reissued(second)]);
		await parentShows(last(recorded));
		expect(noticesIn(container)).toEqual([NOTICE_TEXT, undefined]);

		await press(updateOf(rowAt(container, 0)));
		expect(asked).toEqual(["second", "first"]);
		expect(last(recorded)).toEqual([reissued(first), reissued(second)]);
		await parentShows(last(recorded));
		expect(noticesIn(container)).toEqual([undefined, undefined]);
	});
});

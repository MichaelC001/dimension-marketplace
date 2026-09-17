import { describe, expect, test } from "bun:test";
import { footerLine, parseLinkInput, type SessionReviewLink } from "../src/model";

const OWN = { provider: "github", host: "github.com", repository: "insodimension/dimension" };

function link(number: number, state: "open" | "merged" | null, syncedAt = "2026-09-14T10:00:00.000Z"): SessionReviewLink {
	const ref = { ...OWN, number };
	return {
		ref,
		url: `https://github.com/insodimension/dimension/pull/${number}`,
		source: "manual",
		evidence: [],
		linkedAt: "2026-09-14T09:00:00.000Z",
		stack: null,
		snapshot:
			state === null
				? null
				: {
						ref,
						url: "",
						label: "PR",
						title: "t",
						state,
						isDraft: false,
						headBranch: "a",
						baseBranch: "main",
						updatedAt: syncedAt,
						syncedAt,
						capabilities: { merge: true, draft: true, stackActions: true },
					},
	};
}

describe("parseLinkInput", () => {
	test("a bare number resolves against the checkout's own repository", () => {
		expect(parseLinkInput("#42", OWN)).toEqual({
			ref: { ...OWN, number: 42 },
			url: "https://github.com/insodimension/dimension/pull/42",
		});
		expect(parseLinkInput("42", OWN)?.ref.number).toBe(42);
	});
	test("a bare number with no own repository is refused, not guessed", () => {
		expect(parseLinkInput("#42", null)).toBeNull();
	});
	test("a github URL from another repository links across repos, lowercased", () => {
		expect(parseLinkInput("https://github.com/Other/Backend/pull/7", OWN)).toEqual({
			ref: { provider: "github", host: "github.com", repository: "other/backend", number: 7 },
			url: "https://github.com/Other/Backend/pull/7",
		});
	});
	test("a gitlab merge-request URL is a gitlab ref", () => {
		expect(parseLinkInput("https://gitlab.com/g/sub/repo/-/merge_requests/9", OWN)?.ref).toEqual({
			provider: "gitlab",
			host: "gitlab.com",
			repository: "g/sub/repo",
			number: 9,
		});
	});
	test("non-web schemes and non-review paths are refused", () => {
		expect(parseLinkInput("file:///etc/passwd", OWN)).toBeNull();
		expect(parseLinkInput("https://github.com/insodimension/dimension/issues/3", OWN)).toBeNull();
		expect(parseLinkInput("hello", OWN)).toBeNull();
	});
});

describe("footerLine", () => {
	test("counts an unsynced link as open and reports the newest sync", () => {
		const now = Date.parse("2026-09-14T10:00:20.000Z");
		expect(footerLine([link(1, "open"), link(2, "merged"), link(3, null)], now)).toBe("2 open · 3 linked · synced just now");
	});
	test("omits the sync segment when nothing has synced", () => {
		expect(footerLine([link(3, null)])).toBe("1 open · 1 linked");
	});
});

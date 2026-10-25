import { describe, expect, test } from "bun:test";
import type { SharePolicy } from "@dimension/sdk/artifact-share";
import type { ShareHost } from "../app/view/library/library-tools";
import {
	accessLabel,
	anchorLabel,
	audienceFrom,
	audienceProblem,
	defaultExpiry,
	defaultHost,
	expiryChoices,
	fileChanged,
	hostChoices,
	hostName,
	initials,
	linkChoice,
	parsePairing,
	parseRecipients,
	peopleFrom,
	peopleOf,
	shareDetail,
	shareStatus,
	signinChoice,
} from "../app/view/library/share-options";

const open: SharePolicy = { publicLinks: true, signinRequired: false, maxBytes: 0, maxDays: 0 };
const host = (id: string, extra: Partial<ShareHost> = {}): ShareHost => ({ id, kind: "self", name: id, baseUrl: `https://${id}.example`, status: "ok", oidc: false, managed: false, policy: open, ...extra });
const p2p = host("p2p", { kind: "p2p", name: "From this computer" });

describe("share options follow the host", () => {
	test("from this computer comes first and is the default", () => {
		const choices = hostChoices([host("vps"), p2p], 100);
		expect(choices.map(choice => choice.host.id)).toEqual(["p2p", "vps"]);
		expect(defaultHost(choices)).toBe("p2p");
	});

	test("a host that is down, refuses the token, or takes smaller files is shown but not offered, with its reason", () => {
		const choices = hostChoices([p2p, host("down", { status: "unreachable" }), host("old", { status: "unauthorized" }), host("small", { policy: { ...open, maxBytes: 1024 } })], 4096);
		expect(choices.map(choice => choice.allowed)).toEqual([true, false, false, false]);
		expect(choices[3]?.reason).toContain("4.0 KB");
		expect(defaultHost(hostChoices([host("down", { status: "unreachable" })], 1))).toBeNull();
	});

	test("a host that forbids public links offers only sign-in, and says so in the SDK's words", () => {
		expect(linkChoice({ ...open, publicLinks: false })).toEqual({ allowed: false, reason: "This server only allows shares that require signing in." });
		expect(linkChoice({ ...open, signinRequired: true }).allowed).toBe(false);
		expect(linkChoice(open).allowed).toBe(true);
		expect(linkChoice(undefined).allowed).toBe(true);
	});

	test("sign-in is offered only by a host with sign-in, and says why otherwise", () => {
		expect(signinChoice(host("corp", { kind: "company", oidc: true })).allowed).toBe(true);
		for (const without of [p2p, host("vps"), host("cloud", { kind: "dimension", oidc: true })]) {
			const choice = signinChoice(without);
			expect(choice.allowed).toBe(false);
			expect(choice.reason?.length ?? 0).toBeGreaterThan(10);
		}
	});

	test("expiry never offers more than the host allows, and offers Never only when it allows that", () => {
		expect(expiryChoices(open).map(choice => choice.days)).toEqual([1, 7, 30, 90, undefined]);
		expect(defaultExpiry(expiryChoices(open))).toBe(30);
		const capped = expiryChoices({ ...open, maxDays: 14 });
		expect(capped.map(choice => choice.days)).toEqual([1, 7, 14]);
		expect(defaultExpiry(capped)).toBe(14);
		expect(defaultExpiry(expiryChoices({ ...open, maxDays: 3650 }))).toBe(30);
		expect(expiryChoices({ ...open, maxDays: 30 }).map(choice => choice.days)).toEqual([1, 7, 30]);
	});

	test("recipients split into emails and domains, and a domain policy refuses outsiders", () => {
		expect(parseRecipients("Ana@Example.com, @example.org; bob@x.io example.org")).toEqual({ emails: ["ana@example.com", "bob@x.io"], domains: ["example.org"] });
		const audience = audienceFrom("signin", "ana@example.com, bob@x.io");
		expect(audienceProblem(audience, { ...open, allowedDomains: ["example.com"] })).toBe("This server only shares with example.com.");
		expect(audienceProblem(audienceFrom("signin", "ana@example.com"), { ...open, allowedDomains: ["example.com"] })).toBeUndefined();
		expect(audienceFrom("link", "ignored")).toEqual({ kind: "link" });
	});

	test("people typed into the share box become emails and @domains; anything else is sent back", () => {
		expect(peopleFrom("Ana@Example.com, @acme.com; acme.com bob x@y")).toEqual({ valid: ["ana@example.com", "@acme.com"], invalid: ["bob", "x@y"] });
		const people = peopleOf({ kind: "signin", emails: ["ana@example.com"], domains: ["acme.com"] });
		expect(people).toEqual(["ana@example.com", "@acme.com"]);
		expect(audienceFrom("signin", people.join(" "))).toEqual({ kind: "signin", emails: ["ana@example.com"], domains: ["acme.com"] });
		expect(peopleOf({ kind: "link" })).toEqual([]);
	});

	test("a pairing link needs its token in the fragment; a share names its server, never its link or key", () => {
		expect(parsePairing("https://share.example.com/pair#t=abc")).toEqual({ pairing: "https://share.example.com/pair#t=abc" });
		expect(parsePairing("https://share.example.com/pair")).toBeNull();
		expect(parsePairing("not a url")).toBeNull();
		expect(hostName("https://share.example.com/a/xyz#k=SECRET")).toBe("share.example.com");
	});
});

describe("who has access reads like a person would say it", () => {
	const now = Date.UTC(2026, 9, 26);
	const day = 86_400_000;
	const share = { host: "vps", url: "https://share.example.com/a/xyz", allowComments: true, versionAt: now - day };

	test("an audience is named by who it lets in", () => {
		expect(accessLabel({ kind: "link" })).toBe("Anyone with the link");
		expect(accessLabel({ kind: "signin" })).toBe("Anyone who signs in");
		expect(accessLabel({ kind: "signin", emails: ["ana@example.com"] })).toBe("ana@example.com");
		expect(accessLabel({ kind: "signin", emails: ["ana@example.com", "bo@example.com"] })).toBe("2 people");
		expect(accessLabel({ kind: "signin", domains: ["acme.com"] })).toBe("People at acme.com");
		expect(accessLabel({ kind: "signin", emails: ["ana@example.com"], domains: ["acme.com", "x.io"] })).toBe("ana@example.com and people at 2 domains");
	});

	test("a share's line says the role, the expiry and where it lives", () => {
		expect(shareDetail({ ...share, expiresAt: now + 30 * day }, now)).toMatch(/^Can comment · Expires .+ · On share\.example\.com$/);
		expect(shareDetail({ ...share, host: "p2p", allowComments: false }, now)).toBe("Can view · From this computer (works while it is on)");
		expect(shareDetail({ ...share, expiresAt: now - 1 }, now)).toBe("Can comment · Expired · On share.example.com");
	});

	test("a stopped or expired link is not live", () => {
		expect(shareStatus({}, now)).toBe("live");
		expect(shareStatus({ expiresAt: now + 1 }, now)).toBe("live");
		expect(shareStatus({ expiresAt: now }, now)).toBe("expired");
		expect(shareStatus({ revokedAt: now - 1, expiresAt: now - 1 }, now)).toBe("stopped");
	});

	test("a hosted share whose file changed after its version was published is out of date; a link from this computer is not", () => {
		expect(fileChanged(share, now)).toBe(true);
		expect(fileChanged(share, now - 2 * day)).toBe(false);
		expect(fileChanged({ ...share, host: "p2p" }, now)).toBe(false);
	});

	test("a comment's anchor reads as a time or a page, and its author as initials", () => {
		expect(anchorLabel({ kind: "time", startMs: 70_000 })).toBe("1:10");
		expect(anchorLabel({ kind: "page", page: 3 })).toBe("p. 3");
		expect(anchorLabel({ kind: "region", x: 0, y: 0, w: 1, h: 1 })).toBe("Area");
		expect(anchorLabel(undefined)).toBeNull();
		expect(anchorLabel({ kind: "time" })).toBeNull();
		expect(initials("Ana Lima")).toBe("AL");
		expect(initials("ana.lima@example.com")).toBe("AL");
		expect(initials("bo")).toBe("B");
		expect(initials("  ")).toBe("?");
	});
});

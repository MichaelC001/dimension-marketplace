import { describe, expect, test } from "bun:test";
import type { SharePolicy } from "@dimension/sdk/artifact-share";
import type { ShareHost, ShareHosts } from "../app/view/library/library-tools";
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
	placeOf,
	placesOf,
	shareDetail,
	shareStatus,
	signinChoice,
} from "../app/view/library/share-options";

const open: SharePolicy = { publicLinks: true, signinRequired: false, maxBytes: 0, maxDays: 0 };
const host = (id: string, extra: Partial<ShareHost> = {}): ShareHost => ({ id, kind: "self", name: id, baseUrl: `https://${id}.example`, status: "ok", oidc: false, managed: false, policy: open, ...extra });
const p2p = host("p2p", { kind: "p2p", name: "From this computer" });
const cloud = host("cloud", { kind: "dimension", name: "Dimension cloud", baseUrl: "https://share.insodimension.ai" });

describe("share options follow the host", () => {
	test("without Dimension cloud, from this computer comes first and is the default", () => {
		const choices = hostChoices([host("vps"), p2p], 100);
		expect(choices.map(choice => choice.host.id)).toEqual(["p2p", "vps"]);
		expect(defaultHost(choices)).toBe("p2p");
	});

	test("Dimension cloud comes first and is the default, then this computer, then your own servers, whatever order the hosts arrive in", () => {
		const vps = host("vps");
		const corp = host("corp", { kind: "company" });
		const legacy = host("legacy", { kind: "dimension", name: "Legacy cloud" });
		for (const arrival of [
			[vps, corp, p2p, cloud, legacy],
			[cloud, p2p, vps, corp, legacy],
			[legacy, corp, vps, cloud, p2p],
		]) {
			const choices = hostChoices(arrival, 100);
			expect(choices.slice(0, 2).map(choice => choice.host.id)).toEqual(["cloud", "p2p"]);
			expect(choices.slice(2).map(choice => choice.host.id).sort()).toEqual(["corp", "legacy", "vps"]);
			expect(defaultHost(choices)).toBe("cloud");
		}
		const down = { status: "unreachable" } as const;
		expect(defaultHost(hostChoices([vps, p2p, { ...cloud, ...down }], 100))).toBe("p2p");
		expect(defaultHost(hostChoices([vps, { ...p2p, ...down }, { ...cloud, ...down }], 100))).toBe("vps");
	});

	test("a file over the limit is refused by Dimension cloud and your own servers in their own words, but a link from this computer has no limit", () => {
		const limited = { ...open, maxBytes: 1024 };
		const hosts = [host("vps", { policy: limited }), host("legacy", { kind: "dimension", policy: limited }), { ...p2p, policy: limited }, { ...cloud, policy: limited }];
		const verdict = (size: number) => Object.fromEntries(hostChoices(hosts, size).map(choice => [choice.host.id, choice]));
		expect(Object.values(verdict(1024)).map(choice => choice.allowed)).toEqual([true, true, true, true]);
		const over = verdict(4096);
		expect(over.cloud?.allowed).toBe(false);
		expect(over.cloud?.reason).toContain("Dimension cloud takes files up to 1.0 KB");
		for (const server of [over.vps, over.legacy]) {
			expect(server?.allowed).toBe(false);
			expect(server?.reason).toContain("this server takes files up to 1.0 KB");
			expect(server?.reason).not.toContain("Dimension cloud");
		}
		expect(verdict(50 * 2 ** 30).p2p?.allowed).toBe(true);
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

describe("the places the share dialog offers", () => {
	const listing = (hosts: readonly ShareHost[], extra: Partial<ShareHosts> = {}): ShareHosts => ({ hosts, p2pAllowed: true, cloudAllowed: true, ...extra });
	const vps = host("vps");
	const corp = host("corp", { kind: "company", name: "Corp share" });
	const legacy = host("legacy", { kind: "dimension", name: "Legacy cloud" });

	test("are always Dimension cloud, this computer, then each of your servers, with the cloud's retention and any refusal on its card", () => {
		const hosts = [vps, p2p, legacy, corp, { ...cloud, policy: { ...open, maxDays: 30, maxBytes: 1024 } }];
		const fits = placesOf(listing(hosts), hostChoices(hosts, 100));
		expect(fits.places.map(place => place.id)).toEqual(["cloud", "p2p", "vps", "legacy", "corp"]);
		expect(fits.places.map(place => place.title)).toEqual(["Dimension cloud", "This computer", "vps", "Legacy cloud", "Corp share"]);
		expect(fits.places.every(place => place.allowed)).toBe(true);
		expect(fits.places[0]?.detail).toContain("up to 30 days");
		expect(fits.servers).toBe(3);
		expect(fits.retryable).toBe(false);
		const tooBig = placesOf(listing(hosts), hostChoices(hosts, 4096));
		expect(tooBig.places[0]).toMatchObject({ id: "cloud", allowed: false });
		expect(tooBig.places[0]?.reason).toContain("Dimension cloud takes files up to 1.0 KB");
		expect(tooBig.places[1]).toMatchObject({ id: "p2p", allowed: true });
	});

	test("a cloud that did not answer can be retried, one the administrator turned off cannot, and a stored cloud-kind server is never mistaken for it", () => {
		const hosts = [legacy, p2p];
		const retryable = placesOf(listing(hosts), hostChoices(hosts, 100));
		expect(retryable.places.map(place => place.id)).toEqual(["cloud", "p2p", "legacy"]);
		expect(retryable.places[0]).toMatchObject({ allowed: false, reason: "Not answering right now. Try again in a moment.", retry: true });
		expect(retryable.places[2]).toMatchObject({ allowed: true, title: "Legacy cloud" });
		expect(retryable.retryable).toBe(true);
		const off = placesOf(listing(hosts, { cloudAllowed: false }), hostChoices(hosts, 100));
		expect(off.places[0]).toMatchObject({ id: "cloud", allowed: false, reason: "Your administrator turned this off." });
		expect(off.places[0]?.retry).toBeUndefined();
		expect(off.retryable).toBe(false);
		expect(off.servers).toBe(1);
	});

	test("this computer is still listed when the administrator turned it off, with the reason and nothing to retry", () => {
		const hosts = [cloud, vps];
		const result = placesOf(listing(hosts, { p2pAllowed: false }), hostChoices(hosts, 100));
		expect(result.places.map(place => place.id)).toEqual(["cloud", "p2p", "vps"]);
		expect(result.places[1]).toMatchObject({ allowed: false, reason: "Your administrator turned this off." });
		expect(result.places[1]?.retry).toBeUndefined();
		expect(result.retryable).toBe(false);
	});

	test("a server that is down can be retried, one that refuses the token cannot, and either leaves the others usable", () => {
		const down = { ...vps, status: "unreachable" } as const;
		const refused = { ...corp, status: "unauthorized" } as const;
		const downResult = placesOf(listing([cloud, p2p, down]), hostChoices([cloud, p2p, down], 100));
		expect(downResult.places[2]).toMatchObject({ id: "vps", allowed: false, retry: true });
		expect(downResult.retryable).toBe(true);
		expect(downResult.places.slice(0, 2).every(place => place.allowed)).toBe(true);
		const refusedResult = placesOf(listing([cloud, p2p, refused]), hostChoices([cloud, p2p, refused], 100));
		expect(refusedResult.places[2]).toMatchObject({ id: "corp", allowed: false });
		expect(refusedResult.places[2]?.reason).toContain("pairing link");
		expect(refusedResult.places[2]?.retry).toBeUndefined();
		expect(refusedResult.retryable).toBe(false);
	});
});

describe("where a share lives reads like a person would say it", () => {
	const url = "https://share.insodimension.ai/a/xyz";
	const now = Date.UTC(2026, 9, 26);

	test("a link from this computer, one on Dimension cloud and one on your own server are told apart, whatever address they carry", () => {
		expect(placeOf({ host: "p2p", url: "https://t-1.share.insodimension.ai/a/xyz" })).toBe("From this computer (works while it is on)");
		expect(placeOf({ host: "cloud", url })).toBe("On Dimension cloud");
		expect(placeOf({ host: "h_1a2b3c", url: "https://share.example.com/a/xyz" })).toBe("On share.example.com");
		expect(placeOf({ host: "h_1a2b3c", url })).toBe("On share.insodimension.ai");
		expect(placeOf({ host: "h_1a2b3c", url: "not a url" })).toBe("On a share server");
	});

	test("a cloud share's line says so instead of naming the address", () => {
		expect(shareDetail({ host: "cloud", url, allowComments: false }, now)).toBe("Can view · On Dimension cloud");
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

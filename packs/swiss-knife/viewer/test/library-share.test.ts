import { describe, expect, test } from "bun:test";
import type { SharePolicy } from "@dimension/sdk/artifact-share";
import type { ShareHost } from "../app/view/library/library-tools";
import {
	audienceFrom,
	audienceProblem,
	defaultExpiry,
	defaultHost,
	displayUrl,
	expiryChoices,
	hostChoices,
	linkChoice,
	parsePairing,
	parseRecipients,
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

	test("a host that forbids public links offers only sign-in", () => {
		expect(linkChoice({ ...open, publicLinks: false }).allowed).toBe(false);
		expect(linkChoice({ ...open, signinRequired: true }).allowed).toBe(false);
		expect(linkChoice(open).allowed).toBe(true);
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

	test("a pairing link needs its token in the fragment; a share URL shows without its key", () => {
		expect(parsePairing("https://share.example.com/pair#t=abc")).toEqual({ pairing: "https://share.example.com/pair#t=abc" });
		expect(parsePairing("https://share.example.com/pair")).toBeNull();
		expect(parsePairing("not a url")).toBeNull();
		expect(displayUrl("https://share.example.com/a/xyz#k=SECRET")).toBe("share.example.com/a/xyz");
	});
});

import { type Audience, audienceAllowedBy, type SharePolicy } from "@dimension/sdk/artifact-share";
import { formatBytes } from "../format";
import type { ShareHost } from "./library-tools";

export interface Choice {
	readonly allowed: boolean;
	readonly reason?: string;
}

export interface HostChoice extends Choice {
	readonly host: ShareHost;
}

export const INSTALL_COMMAND = "curl -fsSL https://get.insodimension.ai/artifact-host/install.sh | sudo bash -s -- --domain share.example.com";

const STATUS_REASON: Record<Exclude<ShareHost["status"], "ok">, string> = {
	unreachable: "This server is not answering right now.",
	unauthorized: "This server no longer accepts the saved token; add it again with a new pairing link.",
};

export function hostChoices(hosts: readonly ShareHost[], size: number): readonly HostChoice[] {
	const ordered = [...hosts.filter(host => host.kind === "p2p"), ...hosts.filter(host => host.kind !== "p2p")];
	return ordered.map(host => {
		if (host.status !== "ok") return { host, allowed: false, reason: STATUS_REASON[host.status] };
		const maxBytes = host.policy?.maxBytes ?? 0;
		if (Number.isFinite(maxBytes) && maxBytes > 0 && size > maxBytes) return { host, allowed: false, reason: `This file is ${formatBytes(size)}; this server takes files up to ${formatBytes(maxBytes)}.` };
		return { host, allowed: true };
	});
}

export function defaultHost(choices: readonly HostChoice[]): string | null {
	return choices.find(choice => choice.allowed)?.host.id ?? null;
}

export function linkChoice(policy: SharePolicy | undefined): Choice {
	if (policy !== undefined && (!policy.publicLinks || policy.signinRequired)) return { allowed: false, reason: "This server only allows shares that require signing in." };
	return { allowed: true };
}

export function signinChoice(host: ShareHost): Choice {
	if (host.kind === "p2p") return { allowed: false, reason: "Sign-in needs a server with sign-in set up; a link from this computer opens for anyone who has it." };
	if (host.kind === "dimension") return { allowed: false, reason: "Dimension cloud makes link shares until Dimension accounts exist." };
	if (!host.oidc) return { allowed: false, reason: "This server has no sign-in set up, so it can only make links." };
	return { allowed: true };
}

export interface ExpiryChoice {
	readonly days: number | undefined;
	readonly label: string;
}

const EXPIRY_DAYS: readonly number[] = [1, 7, 30, 90];

export function expiryChoices(policy: SharePolicy | undefined): readonly ExpiryChoice[] {
	const maxDays = policy?.maxDays ?? 0;
	const capped = Number.isFinite(maxDays) && maxDays > 0;
	const days = EXPIRY_DAYS.filter(day => !capped || day <= maxDays);
	const choices: ExpiryChoice[] = days.map(day => ({ days: day, label: day === 1 ? "1 day" : `${day} days` }));
	if (capped && !days.includes(maxDays)) choices.push({ days: maxDays, label: `${maxDays} days (this server’s limit)` });
	if (!capped) choices.push({ days: undefined, label: "Never" });
	return choices;
}

export const DEFAULT_EXPIRY_DAYS = 30;

export function defaultExpiry(choices: readonly ExpiryChoice[]): number | undefined {
	const bounded = choices.flatMap(choice => (choice.days !== undefined && choice.days <= DEFAULT_EXPIRY_DAYS ? [choice.days] : []));
	return bounded.length === 0 ? choices[0]?.days : Math.max(...bounded);
}

export function parseRecipients(text: string): { readonly emails: readonly string[]; readonly domains: readonly string[] } {
	const emails: string[] = [];
	const domains: string[] = [];
	for (const raw of text.split(/[\s,;]+/)) {
		const entry = raw.trim().toLowerCase().replace(/^@/, "");
		if (entry === "") continue;
		const bucket = entry.includes("@") ? emails : domains;
		if (!bucket.includes(entry)) bucket.push(entry);
	}
	return { emails, domains };
}

export function audienceFrom(kind: Audience["kind"], recipients: string): Audience {
	if (kind === "link") return { kind: "link" };
	const { emails, domains } = parseRecipients(recipients);
	return { kind: "signin", ...(emails.length === 0 ? {} : { emails }), ...(domains.length === 0 ? {} : { domains }) };
}

export function audienceProblem(audience: Audience, policy: SharePolicy | undefined): string | undefined {
	if (policy === undefined) return undefined;
	const refused = audienceAllowedBy(audience, policy);
	return refused === undefined ? undefined : `${refused.charAt(0).toUpperCase()}${refused.slice(1)}.`;
}

export function audienceLabel(audience: Audience): string {
	if (audience.kind === "link") return "Anyone with the link";
	const who = [...(audience.emails ?? []), ...(audience.domains ?? []).map(domain => `@${domain}`)];
	return who.length === 0 ? "Anyone who signs in" : `Signed in: ${who.join(", ")}`;
}

export function displayUrl(url: string): string {
	const bare = url.split("#")[0] ?? url;
	return bare.replace(/^https?:\/\//, "");
}

export function parsePairing(text: string): { readonly pairing: string } | null {
	const trimmed = text.trim();
	try {
		const url = new URL(trimmed);
		if ((url.protocol === "https:" || url.protocol === "http:") && /(?:^|[#&])t=/.test(url.hash.slice(1))) return { pairing: trimmed };
	} catch {
		return null;
	}
	return null;
}

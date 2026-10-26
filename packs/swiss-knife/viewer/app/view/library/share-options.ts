import { type Audience, audienceAllowedBy, type SharePolicy } from "@dimension/sdk/artifact-share";
import type { ShareSummary } from "../../../../src/library/types";
import { formatBytes } from "../format";
import { formatDuration } from "./kinds";
import type { ShareHost } from "./library-tools";

export interface Choice {
	readonly allowed: boolean;
	readonly reason?: string;
}

export interface HostChoice extends Choice {
	readonly host: ShareHost;
}

const HOST_COMPOSE = "docker compose -f packages/artifact-host/deploy/docker-compose.yml";

export const HOST_SETUP: readonly { readonly label: string; readonly command: string }[] = [
	{ label: "Start the share server", command: `ARTIFACT_HOST_DOMAIN=share.example.com ARTIFACT_HOST_UPLOAD_TOKEN=$(openssl rand -base64 32) ${HOST_COMPOSE} up -d` },
	{ label: "Print its pairing link", command: `${HOST_COMPOSE} exec artifact-host /usr/local/bin/artifact-host admin pair` },
];

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
	const problem = audienceProblem({ kind: "link" }, policy);
	return problem === undefined ? { allowed: true } : { allowed: false, reason: problem };
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

const EMAIL = /^[^@\s]+@[a-z0-9-]+(\.[a-z0-9-]+)+$/;
const DOMAIN = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/;

export function peopleFrom(text: string): { readonly valid: readonly string[]; readonly invalid: readonly string[] } {
	const valid: string[] = [];
	const invalid: string[] = [];
	for (const raw of text.split(/[\s,;]+/)) {
		const entry = raw.trim().toLowerCase();
		if (entry === "") continue;
		const domain = entry.replace(/^@/, "");
		const person = !entry.startsWith("@") && entry.includes("@") ? (EMAIL.test(entry) ? entry : null) : DOMAIN.test(domain) ? `@${domain}` : null;
		if (person === null) invalid.push(raw.trim());
		else if (!valid.includes(person)) valid.push(person);
	}
	return { valid, invalid };
}

export function peopleOf(audience: Audience): readonly string[] {
	return audience.kind === "link" ? [] : [...(audience.emails ?? []), ...(audience.domains ?? []).map(domain => `@${domain}`)];
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

export function accessLabel(audience: Audience): string {
	if (audience.kind === "link") return "Anyone with the link";
	const emails = audience.emails ?? [];
	const domains = audience.domains ?? [];
	const people = emails.length === 1 ? (emails[0] ?? "") : `${emails.length} people`;
	const at = domains.length === 1 ? (domains[0] ?? "") : `${domains.length} domains`;
	if (emails.length === 0) return domains.length === 0 ? "Anyone who signs in" : `People at ${at}`;
	return domains.length === 0 ? people : `${people} and people at ${at}`;
}

export function shareStatus(share: Pick<ShareSummary, "revokedAt" | "expiresAt">, now: number): "live" | "stopped" | "expired" {
	if (share.revokedAt !== undefined) return "stopped";
	if (share.expiresAt !== undefined && share.expiresAt <= now) return "expired";
	return "live";
}

export function shareDetail(share: Pick<ShareSummary, "host" | "url" | "expiresAt" | "allowComments">, now: number): string {
	const parts = [share.allowComments ? "Can comment" : "Can view"];
	if (share.expiresAt !== undefined) parts.push(share.expiresAt <= now ? "Expired" : `Expires ${shortDate(share.expiresAt, now)}`);
	parts.push(share.host === "p2p" ? "From this computer (works while it is on)" : `On ${hostName(share.url)}`);
	return parts.join(" · ");
}

export function fileChanged(share: Pick<ShareSummary, "host" | "versionAt">, mtimeMs: number): boolean {
	return share.host !== "p2p" && mtimeMs > share.versionAt;
}

export function hostName(url: string): string {
	try {
		return new URL(url).host;
	} catch {
		return "a share server";
	}
}

export function shortDate(at: number, now: number): string {
	const sameYear = new Date(at).getFullYear() === new Date(now).getFullYear();
	return new Date(at).toLocaleDateString(undefined, sameYear ? { month: "short", day: "numeric" } : { year: "numeric", month: "short", day: "numeric" });
}

export function anchorLabel(anchor: unknown): string | null {
	if (typeof anchor !== "object" || anchor === null || !("kind" in anchor)) return null;
	if (anchor.kind === "time" && "startMs" in anchor && typeof anchor.startMs === "number") return formatDuration(anchor.startMs);
	if (anchor.kind === "page" && "page" in anchor && typeof anchor.page === "number") return `p. ${anchor.page}`;
	if (anchor.kind === "region") return "Area";
	return null;
}

export function initials(name: string): string {
	const words = (name.split("@")[0] ?? "").trim().split(/[\s._-]+/).filter(word => word !== "");
	const letters = words.length > 1 ? [words[0], words[words.length - 1]] : [words[0]];
	return letters.map(word => word?.charAt(0).toUpperCase() ?? "").join("") || "?";
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

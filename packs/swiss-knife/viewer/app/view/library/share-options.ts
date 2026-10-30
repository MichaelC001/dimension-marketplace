import { type Audience, audienceAllowedBy, type SharePolicy } from "@dimension/sdk/artifact-share";
import type { ShareSummary } from "../../../../src/library/types";
import { formatBytes } from "../format";
import type { ShareHost, ShareHosts } from "./library-tools";

export interface Choice {
	readonly allowed: boolean;
	readonly reason?: string;
	readonly retry?: true;
}

export interface HostChoice extends Choice {
	readonly host: ShareHost;
}

export const CLOUD_HOST = "cloud";

export const OWN_SERVER_PROMPT = [
	"Set up my own share server for Dimension's Library, so the links I share keep working while my computer is off.",
	"Ask me which machine to use (a VPS I can reach over SSH, or a company server) and which web address it should have.",
	"Install artifact-host from the Dimension repo there (packages/artifact-host/deploy: the install script, or Docker Compose with Caddy for HTTPS), check it answers at https://<address>/.well-known/dimension-artifacts, then print its pairing link with `artifact-host admin pair`.",
	"Give me that pairing link and tell me to paste it under Your own server in the Share dialog.",
].join(" ");

const UNREACHABLE = "Not answering right now. Try again in a moment.";
const ADMIN_OFF = "Your administrator turned this off.";
const CLOUD_DETAIL = "Always on. An encrypted copy is kept on Dimension's server";
const P2P_DETAIL = "Nothing is uploaded. The file is sent straight from here, encrypted.";
const P2P_TIP = "The link opens only while this computer is on and Dimension is running. When it sleeps or Dimension closes, people see that it is not available until you are back.";

function placeRank(host: ShareHost): number {
	if (host.id === CLOUD_HOST) return 0;
	return host.kind === "p2p" ? 1 : 2;
}

export function hostChoices(hosts: readonly ShareHost[], size: number): readonly HostChoice[] {
	const ordered = [...hosts].sort((a, b) => placeRank(a) - placeRank(b));
	return ordered.map(host => {
		if (host.status === "unreachable") return { host, allowed: false, reason: UNREACHABLE, retry: true };
		if (host.status === "unauthorized") return { host, allowed: false, reason: "This server no longer accepts the saved token; paste a new pairing link." };
		const maxBytes = host.kind === "p2p" ? 0 : (host.policy?.maxBytes ?? 0);
		if (Number.isFinite(maxBytes) && maxBytes > 0 && size > maxBytes) return { host, allowed: false, reason: `This file is ${formatBytes(size)}; ${host.id === CLOUD_HOST ? "Dimension cloud" : "this server"} takes files up to ${formatBytes(maxBytes)}.` };
		return { host, allowed: true };
	});
}

export interface Place extends Choice {
	readonly id: string;
	readonly icon: "cloud" | "computer" | "box";
	readonly title: string;
	readonly detail: string;
	readonly badge?: { readonly text: string; readonly tip?: string };
}

export interface Places {
	readonly places: readonly Place[];
	readonly servers: number;
	readonly retryable: boolean;
}

function cloudPlace(choice: Choice, maxDays: number | undefined): Place {
	return { ...choice, id: CLOUD_HOST, icon: "cloud", title: "Dimension cloud", detail: maxDays === undefined ? `${CLOUD_DETAIL}.` : `${CLOUD_DETAIL} for up to ${maxDays} days.`, badge: { text: "Recommended" } };
}

function p2pPlace(choice: Choice): Place {
	return { ...choice, id: "p2p", icon: "computer", title: "This computer", detail: P2P_DETAIL, badge: { text: "Only while it is on", tip: P2P_TIP } };
}

function serverPlace({ host, ...choice }: HostChoice): Place {
	return { ...choice, id: host.id, icon: "box", title: host.name, detail: `Your ${host.kind === "company" ? "company's " : ""}server at ${hostName(host.baseUrl)}. Always on.` };
}

export function placesOf(listing: ShareHosts, choices: readonly HostChoice[]): Places {
	const cloud = choices.find(choice => choice.host.id === CLOUD_HOST);
	const p2p = choices.find(choice => choice.host.kind === "p2p");
	const servers = choices.filter(choice => choice !== cloud && choice !== p2p);
	const places = [
		cloud === undefined ? cloudPlace(listing.cloudAllowed ? { allowed: false, reason: UNREACHABLE, retry: true } : { allowed: false, reason: ADMIN_OFF }, undefined) : cloudPlace(cloud, cloud.host.policy?.maxDays),
		p2pPlace(p2p ?? { allowed: false, reason: ADMIN_OFF }),
		...servers.map(serverPlace),
	];
	return { places, servers: servers.length, retryable: places.some(place => place.retry === true) };
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
	parts.push(placeOf(share));
	return parts.join(" · ");
}

export function placeOf(share: Pick<ShareSummary, "host" | "url">): string {
	if (share.host === "p2p") return "From this computer (works while it is on)";
	if (share.host === CLOUD_HOST) return "On Dimension cloud";
	return `On ${hostName(share.url)}`;
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

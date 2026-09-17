// The pack's STRUCTURAL view of the host's review facts (doc 73 §2) and its
// own pure helpers. A pack does not import `@fraym/driver`, so the shapes it
// reads are restated here by the members it uses — the same stance as
// `session-tools`. If the host publishes a field this file does not name, the
// pack simply does not draw it.

export interface ReviewRef {
	readonly provider: string;
	readonly host: string;
	readonly repository: string;
	readonly number: number;
}

export type ReviewState = "open" | "closed" | "merged";
export type ChecksState = "passing" | "failing" | "pending";

/** Why the checkout's reviews cannot be read (`workspace/<id>/reviewsUnavailable`). */
export interface ReviewsUnavailable {
	readonly reason: "no-provider" | "missing-tool" | "unauthenticated" | "rate-limited" | "failed";
	readonly message: string;
	readonly command?: string;
	readonly host?: string;
	readonly at: string;
}

export interface ReviewSummary {
	readonly ref: ReviewRef;
	readonly url: string;
	readonly label: string;
	readonly title: string;
	readonly state: ReviewState;
	readonly isDraft: boolean;
	readonly headBranch: string;
	readonly baseBranch: string;
	readonly author?: { readonly login: string };
	readonly additions?: number;
	readonly deletions?: number;
	readonly checksState?: ChecksState | null;
	readonly mergeability?: "mergeable" | "conflicting" | "unknown";
	readonly reviewDecision?: "approved" | "changes-requested" | "review-required" | null;
	readonly updatedAt: string;
	readonly capabilities: {
		readonly merge: boolean;
		readonly draft: boolean;
		readonly stackActions: boolean;
		/** Line threads are readable at all (`getReviewThreads`). */
		readonly reviewThreads?: boolean;
		/** The file diff is readable at all (`getReviewDiff`). */
		readonly diff?: boolean;
		/** Reply / resolve inside a line thread. */
		readonly threadReplies?: boolean;
		/** A whole-review verdict. */
		readonly verdicts?: boolean;
	};
}

export type LinkSource = "created" | "pushed" | "agent" | "manual" | "stack" | "stack-dismissed";

export interface StackLayer {
	readonly number: number;
	readonly headBranch: string;
	readonly headSha?: string;
	readonly state: ReviewState;
	readonly isDraft?: boolean;
	readonly title?: string;
}

export interface Stack {
	readonly kind: "native";
	readonly number: number;
	readonly base: string;
	readonly layers: readonly StackLayer[];
}

export interface SessionReviewLink {
	readonly ref: ReviewRef;
	readonly url: string;
	readonly source: LinkSource;
	readonly snapshot: (ReviewSummary & { readonly syncedAt: string }) | null;
	readonly stack: Stack | null;
}

export interface ReviewThread {
	readonly id: string;
	readonly path?: string;
	readonly line?: number;
	readonly isResolved: boolean;
	readonly isOutdated: boolean;
	readonly comments: readonly {
		readonly id: string;
		readonly author?: { readonly login: string; readonly avatarUrl?: string };
		readonly body: string;
		readonly createdAt: string;
	}[];
}

export interface ReviewDetail extends ReviewSummary {
	readonly body: string;
	readonly labels: readonly { readonly name: string }[];
	readonly reviewers: readonly { readonly login: string }[];
	readonly checks: readonly { readonly name: string; readonly status: string }[];
	readonly viewer: { readonly merge: boolean; readonly stackRebase: boolean };
	readonly allowedMergeMethods: readonly ("merge" | "squash" | "rebase")[];
	readonly stack: Stack | null;
}

export interface ReviewDiffFile {
	readonly path: string;
	readonly additions: number;
	readonly deletions: number;
	readonly patch?: string;
}

/** The host's request cell (doc 73 §7) — what a rail chip asked this viewer to show. */
export interface ReviewRequest {
	readonly ref: ReviewRef;
}

export function refKey(ref: ReviewRef): string {
	return `${ref.provider}:${ref.host}/${ref.repository}#${ref.number}`;
}

/** The three-word footer: how much is live · how much is attached · how much
 *  to trust the screen (doc 73 §10). An unsynced link counts as open. */
export function footerLine(links: readonly SessionReviewLink[], now = Date.now()): string {
	const open = links.filter(link => link.snapshot === null || link.snapshot.state === "open").length;
	let latest: string | null = null;
	for (const link of links) {
		const at = link.snapshot?.syncedAt;
		if (at !== undefined && (latest === null || at > latest)) latest = at;
	}
	const synced = latest === null ? "" : ` · synced ${relativeTime(latest, now)}`;
	return `${open} open · ${links.length} linked${synced}`;
}

export function relativeTime(iso: string, now = Date.now()): string {
	const at = Date.parse(iso);
	if (!Number.isFinite(at)) return "";
	const seconds = Math.max(0, Math.round((now - at) / 1000));
	if (seconds < 45) return "now";
	const minutes = Math.round(seconds / 60);
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.round(minutes / 60);
	if (hours < 24) return `${hours}h`;
	const days = Math.round(hours / 24);
	return `${days}d`;
}

/** A pasted review: a full URL on any host the checkout can reach, or a bare
 *  `#123` / `123` against the checkout's own repository. Returns null for
 *  anything else — the dialog states why. */
export function parseLinkInput(
	raw: string,
	own: { readonly provider: string; readonly host: string; readonly repository: string } | null,
): { readonly ref: ReviewRef; readonly url: string } | null {
	const text = raw.trim();
	const bare = /^#?(\d+)$/.exec(text);
	if (bare) {
		const number = Number(bare[1]);
		if (!own || !Number.isSafeInteger(number) || number <= 0) return null;
		return {
			ref: { ...own, number },
			url: `https://${own.host}/${own.repository}/${own.provider === "gitlab" ? "-/merge_requests" : "pull"}/${number}`,
		};
	}
	let url: URL;
	try {
		url = new URL(text);
	} catch {
		return null;
	}
	if (url.protocol !== "https:" && url.protocol !== "http:") return null;
	const host = url.host.toLowerCase();
	// github · forgejo · gitea: /owner/repo/pull(s)/N — gitlab: /group/repo/-/merge_requests/N
	const gh = /^\/([^/]+\/[^/]+)\/pulls?\/(\d+)/.exec(url.pathname);
	const gl = /^\/(.+?)\/-\/merge_requests\/(\d+)/.exec(url.pathname);
	const match = gh ?? gl;
	if (!match?.[1] || !match[2]) return null;
	const number = Number(match[2]);
	if (!Number.isSafeInteger(number) || number <= 0) return null;
	const provider = gl ? "gitlab" : host === "github.com" || host.endsWith(".ghe.com") ? "github" : (own?.provider ?? "github");
	return { ref: { provider, host, repository: match[1].toLowerCase(), number }, url: url.href };
}

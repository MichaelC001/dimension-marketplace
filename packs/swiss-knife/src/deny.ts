// Which paths `present` will never touch. A copy of the viewer's secret rules.
//
// `present` reads a file the agent names and hands the human a thumbnail of it;
// a model steered by a prompt-injected page must not be able to point it at
// `~/.ssh/id_rsa` and have the pixels (or the name and size) land in the thread.
// The viewer pack already owns the definition of "a secret path"
// (`marketplace/packs/viewer/src/fence.ts`: `denyReason`, the tables it reads, and
// `textRefusal`). Packs install one at a time and cannot import each other, so the
// tables are copied here, not re-derived, and exported so `test/deny.test.ts` can
// hold them equal to the viewer's BY VALUE (every key, every path, every regex
// source and flag) and run both text refusals over the Windows spellings: a rule
// added to one pack and not the other is a red test, whether or not any corpus
// path happens to exercise it. When either list changes, change both.
//
// Two lines of defence, both run on the path as written AND on its real path:
// `textRefusal` decides from the TEXT alone (no filesystem call: `realpath` on a
// `\\host\share` spelling would make the OS authenticate to a host the model
// chose), then `denyReason` names a credentials category.

type Platform = NodeJS.Platform;

export const SECRET_DIRECTORIES: Readonly<Record<string, true>> = {
	".ssh": true,
	".gnupg": true,
	".aws": true,
	".azure": true,
	".kube": true,
	".docker": true,
	".git": true,
	".password-store": true,
	keyrings: true,
	// The Personal vault's Locker (`<vault>/locker`, `<vault>/projects/<p>/locker`):
	// sealed entries beside a plaintext control file and audit log. Any folder of
	// that name is refused: over-denying a folder called `locker` is harmless
	// where under-denying one is not.
	locker: true,
};

/** Consecutive folder names that mark a credential store. */
export const SECRET_PATHS: readonly (readonly string[])[] = [
	[".config", "gcloud"],
	["microsoft", "credentials"],
	["microsoft", "protect"],
	["microsoft", "vault"],
	["library", "keychains"],
];

export const SECRET_FILES: Readonly<Record<string, true>> = {
	".netrc": true,
	_netrc: true,
	".npmrc": true,
	".pypirc": true,
	".pgpass": true,
	".git-credentials": true,
	".s3cfg": true,
	credentials: true,
	"credentials.json": true,
	"credentials.db": true,
	"secrets.json": true,
	"secrets.yml": true,
	"secrets.yaml": true,
	token: true,
	"token.json": true,
	"tokens.json": true,
	"auth.json": true,
	"service-account.json": true,
	// Browser profile stores.
	"login data": true,
	cookies: true,
	"cookies.sqlite": true,
	"logins.json": true,
	"key3.db": true,
	"key4.db": true,
	// The desktop app's install identity: a bearer for the crowd API.
	"activation.json": true,
	// The Locker's control file, wherever a copy of it ended up (a backup, an export).
	"_locker.json": true,
};

export const PRIVATE_KEY_FILE =
	/^(?:id_(?:rsa|dsa|ecdsa|ed25519)(?:\..*)?|.*\.(?:pem|key|p12|pfx|ppk|jks|keystore|kdbx))$/;
export const ENVIRONMENT_FILE = /^(?:\.env.*|.*\.env)$/;
export const OTHER_SECRET_FILE = /^(?:client_secret.*\.json|.*\.tfstate(?:\.backup)?|.*\.kubeconfig|.*\.secret\.json)$/;
export const DATABASE_FILE = /\.(?:db|sqlite3?)(?:-wal|-shm|-journal)?$/;
/** `.inso`, `.inso-dev`, `.omp` and their suffixed variants. */
export const ENGINE_HOME = /^\.(?:inso|omp)(?:-[a-z0-9._-]+)?$/;

/**
 * Why `path` must never be presented, or `undefined` when nothing on it is
 * forbidden. Matching is case-insensitive on every platform: over-denying `.ENV`
 * on a case-sensitive disk is harmless, under-denying it on NTFS is not. A
 * refusal names a CATEGORY, never the content.
 */
export function denyReason(path: string): string | undefined {
	const segments = path
		.toLowerCase()
		.split(/[\\/]+/)
		.filter(part => part !== "");
	const base = segments[segments.length - 1] ?? "";
	for (const segment of segments) {
		if (Object.hasOwn(SECRET_DIRECTORIES, segment)) return `it is inside a credentials folder (${segment})`;
	}
	for (const secret of SECRET_PATHS) {
		for (let at = 0; at + secret.length <= segments.length; at++) {
			if (secret.every((part, index) => segments[at + index] === part)) {
				return `it is inside a credentials store (${secret.join("/")})`;
			}
		}
	}
	if (ENVIRONMENT_FILE.test(base)) return "it is an environment file (.env), which holds secrets";
	if (PRIVATE_KEY_FILE.test(base)) return "it is a private key or certificate file";
	if (Object.hasOwn(SECRET_FILES, base) || OTHER_SECRET_FILE.test(base)) return "it is a credentials or token file";
	for (let at = 0; at < segments.length; at++) {
		if (!ENGINE_HOME.test(segments[at] ?? "")) continue;
		const next = segments[at + 1];
		if (next === "agent" || (next === "profiles" && segments[at + 3] === "agent")) {
			return "it is the engine's agent state (credentials, sessions and databases)";
		}
		if (DATABASE_FILE.test(base)) return "it is a database inside an engine home";
	}
	return undefined;
}

/**
 * Why a requested path is refused on its text alone, before any filesystem call,
 * or `undefined`. Relative paths are fine here (the caller resolves them against
 * the session's working directory); what is refused is a spelling the operating
 * system would act on: a NUL, a Windows device path, an alternate data stream,
 * or a network path (resolving one is a network request).
 */
export function textRefusal(requested: string, platform: Platform = process.platform): string | undefined {
	if (requested.trim() === "") return "the path is empty";
	if (requested.includes("\0")) return "the path contains a NUL byte";
	if (platform === "win32") {
		if (/^[\\/]{2}[.?][\\/]/.test(requested)) return "Windows device paths (\\\\.\\ and \\\\?\\) are not presentable";
		if (requested.slice(2).includes(":")) return "alternate data streams (a ':' after the drive) are not presentable";
		// Any two leading separators, either kind: `\\host\share`, `//host/share`,
		// `\\host@SSL@443\DavWWWRoot\x`. No legitimate one is a local file.
		if (/^[\\/]{2}/.test(requested)) return "network paths (\\\\host\\share) are not presentable";
	}
	return undefined;
}

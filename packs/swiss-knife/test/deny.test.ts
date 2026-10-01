import { describe, expect, test } from "bun:test";
import * as viewer from "../../viewer/src/fence";
import * as copy from "../src/deny";

const { denyReason, textRefusal } = copy;

// The deny tables are a deliberate COPY of the viewer pack's (packs install one at a time
// and cannot import each other). The copy is pinned here twice over: the tables themselves
// are held equal (every entry, every regular expression), and both functions run over one
// corpus and must agree on the verdict AND the words.
const SECRET_FOLDERS = [".ssh", ".gnupg", ".aws", ".azure", ".kube", ".docker", ".git", ".password-store", "keyrings", "locker"];

const SECRET_FILE_NAMES = [
	".netrc",
	"_netrc",
	".npmrc",
	".pypirc",
	".pgpass",
	".git-credentials",
	".s3cfg",
	"credentials",
	"credentials.json",
	"credentials.db",
	"secrets.json",
	"secrets.yml",
	"secrets.yaml",
	"token",
	"token.json",
	"tokens.json",
	"auth.json",
	"service-account.json",
	"Login Data",
	"Cookies",
	"cookies.sqlite",
	"logins.json",
	"key3.db",
	"key4.db",
	"activation.json",
	"_locker.json",
];

/** Every path here must be refused, grouped by the rule that refuses it. */
const DENIED: Record<string, string[]> = {
	"credentials folders": SECRET_FOLDERS.flatMap(folder => [
		`/home/me/${folder}/notes.txt`, // a harmless name: only the folder gives it away
		`C:\\Users\\Me\\${folder.toUpperCase()}\\notes.txt`,
		`/home/me/${folder}`,
	]),
	"credential stores (consecutive folders)": [
		"/home/me/.config/gcloud/notes.txt",
		"C:\\Users\\Me\\AppData\\Roaming\\Microsoft\\Credentials\\ABC",
		"C:\\Users\\Me\\AppData\\Roaming\\Microsoft\\Protect\\S-1-5\\x",
		"C:\\Users\\Me\\AppData\\Local\\MICROSOFT\\VAULT\\x",
		"/Users/me/Library/Keychains/login.keychain-db",
	],
	"secret file names": SECRET_FILE_NAMES.flatMap(name => [`/home/me/docs/${name}`, `C:\\Users\\Me\\${name.toUpperCase()}`]),
	"private keys and certificates": [
		...["pem", "key", "p12", "pfx", "ppk", "jks", "keystore", "kdbx"].flatMap(ext => [`/work/certs/server.${ext}`, `/work/certs/SERVER.${ext.toUpperCase()}`]),
		...["id_rsa", "id_dsa", "id_ecdsa", "id_ed25519", "id_rsa.pub", "id_ed25519.bak"].map(name => `/home/me/keys/${name}`),
	],
	"environment files": [
		"/work/app/.env",
		"/work/app/.env.production",
		"/work/app/.env.local",
		"/work/app/prod.ENV",
		"/work/app/.envrc",
		"C:\\Work\\Docs\\.ENV",
	],
	"other secret files": [
		"/work/gcp/client_secret_123.json",
		"/work/gcp/client_secret.json",
		"/work/infra/terraform.tfstate",
		"/work/infra/terraform.tfstate.backup",
		"/work/infra/prod.kubeconfig",
		"/backups/export/vps-root.SECRET.JSON",
		"C:\\Users\\Me\\.inso\\vault\\locker\\vps-root.secret.json",
	],
	"the engine's agent state": [
		"/home/me/.inso/agent",
		"/home/me/.inso/agent/agent.db",
		"/home/me/.inso/agent/agent.db-wal",
		"/home/me/.inso-dev/agent/config.yml",
		"/home/me/.inso-foo/agent/config.yml",
		"/home/me/.omp/agent/models.yml",
		"/home/me/.inso/profiles/p1/agent/config.yml",
		"C:\\Users\\Me\\.inso-dev\\profiles\\p1\\agent\\config.yml",
		"C:\\Users\\Me\\.OMP\\AGENT\\models.yml",
	],
	"databases inside an engine home": [
		...["db", "sqlite", "sqlite3", "db-wal", "db-shm", "db-journal"].map(ext => `/home/me/.inso/vault/notes.${ext}`),
		"/home/me/.omp/elsewhere/data.db",
		"C:\\Users\\Me\\.inso-dev\\vault\\notes.sqlite",
	],
	"the desktop install identity and the Locker": [
		"C:\\Users\\Me\\AppData\\Local\\Inso\\activation.json",
		"/home/me/.inso/vault/locker",
		"/home/me/.inso/vault/locker/_locker.json",
		"/home/me/.inso/vault/locker/audit.log",
		"D:\\Brain\\LOCKER\\anything.txt",
		"/backups/vault-2026/_locker.json",
	],
};

/** Every path here must be allowed: ordinary files, and near-misses of each rule above. */
const ALLOWED = [
	"/home/me/.inso/vault/report.pdf",
	"/home/me/.inso/vault/agent/photo.png", // an `agent` folder inside the vault is not the engine's
	"/home/me/docs/environment.md",
	"/home/me/docs/key-notes.md",
	"/home/me/docs/token-economics.md",
	"C:\\Work\\Docs\\quarterly.docx",
	"/home/me/.inso/vault/lockers-overview.md", // `locker` must be a whole folder name
	"/home/me/.inso/vault/projects/inso/audit.log", // an audit log that is not the Locker's
	"/home/me/docs/locker-room.pdf",
	"/home/me/docs/secret-recipe.json",
	"/home/me/docs/notes.txt",
	"/home/me/docs/data.db", // a database outside an engine home is an ordinary file
	"/home/me/.insomnia/data.sqlite", // `.insomnia` is not an engine home
	"/home/me/.insomnia/agent/photo.png",
	"/home/me/.ssh-notes/photo.png", // `.ssh` must be a whole folder name
	"/home/me/.config/notes.txt",
	"/home/me/microsoft/notes.txt", // the store is `microsoft/credentials`, consecutive
	"/home/me/docs/credentials-policy.pdf",
	"/home/me/docs/tokens.md",
	"/home/me/docs/idea_rsa_notes.md",
	"/home/me/docs/envelope.png",
	"/home/me/agent/photo.png",
	"C:\\Work\\reports\\a.png",
];

describe("denyReason refuses credentials, keys and engine state", () => {
	for (const [rule, paths] of Object.entries(DENIED)) {
		test(rule, () => {
			for (const path of paths) expect(denyReason(path), path).toBeString();
		});
	}

	test("a refusal names a category, never a path or content", () => {
		for (const path of Object.values(DENIED).flat()) {
			const reason = denyReason(path) ?? "";
			expect(reason, path).toStartWith("it ");
			expect(reason, path).not.toContain("/home/me");
			expect(reason, path).not.toContain("C:\\");
		}
	});
});

describe("denyReason leaves ordinary files alone", () => {
	for (const path of ALLOWED) test(`allows ${path}`, () => expect(denyReason(path)).toBeUndefined());
});

describe("the copied deny tables have not drifted from the viewer pack's", () => {
	// The viewer's own tables, exported for this test: a rule added there and not here fails,
	// whether or not any path in the corpus below happens to exercise it.
	for (const name of ["SECRET_DIRECTORIES", "SECRET_FILES"] as const) {
		test(`${name} holds the same names`, () => {
			expect(Object.keys(viewer[name]).length, "the viewer exports a populated table").toBeGreaterThan(5);
			expect(copy[name]).toEqual(viewer[name]);
		});
	}

	test("SECRET_PATHS holds the same folder sequences", () => {
		const sequences = (paths: readonly (readonly string[])[]) => paths.map(path => JSON.stringify(path)).sort();
		expect(viewer.SECRET_PATHS.length, "the viewer exports a populated table").toBeGreaterThan(2);
		expect(sequences(copy.SECRET_PATHS)).toEqual(sequences(viewer.SECRET_PATHS));
	});

	for (const name of ["PRIVATE_KEY_FILE", "ENVIRONMENT_FILE", "OTHER_SECRET_FILE", "DATABASE_FILE", "ENGINE_HOME"] as const) {
		test(`${name} is the same regular expression`, () => {
			expect(viewer[name]).toBeInstanceOf(RegExp);
			expect([copy[name].source, copy[name].flags]).toEqual([viewer[name].source, viewer[name].flags]);
		});
	}

	test("denyReason agrees on every path, verdict and wording: the corpus, and one path for each entry of the viewer's tables", () => {
		const fromTables = [
			...Object.keys(viewer.SECRET_DIRECTORIES).map(folder => `/home/me/${folder}/notes.txt`),
			...Object.keys(viewer.SECRET_FILES).map(file => `/home/me/docs/${file}`),
			...viewer.SECRET_PATHS.map(sequence => `/home/me/${sequence.join("/")}/notes.txt`),
		];
		const corpus = [...Object.values(DENIED).flat(), ...ALLOWED, ...fromTables];
		const disagreements = corpus
			.map(path => ({ path, swissKnife: denyReason(path), viewer: viewer.denyReason(path) }))
			.filter(row => row.swissKnife !== row.viewer);
		expect(
			disagreements,
			"marketplace/packs/swiss-knife/src/deny.ts denyReason and marketplace/packs/viewer/src/fence.ts denyReason disagree: the deny table is a copy, change both",
		).toEqual([]);
	});

	test("the corpus exercises both verdicts, so agreeing on it means something", () => {
		expect(Object.values(DENIED).flat().every(path => viewer.denyReason(path) !== undefined)).toBe(true);
		expect(ALLOWED.every(path => viewer.denyReason(path) === undefined)).toBe(true);
	});
});

/** Spellings the operating system would act on, each refused from the text alone, by the rule that refuses it. */
const WINDOWS_REFUSED: { path: string; reason: string }[] = [
	{ path: "\\\\?\\C:\\a.png", reason: "device paths" },
	{ path: "//?/C:/a.png", reason: "device paths" },
	{ path: "\\\\.\\pipe\\x", reason: "device paths" },
	{ path: "C:\\a.txt:hidden", reason: "alternate data streams" },
	{ path: "C:\\dir\\a.png:Zone.Identifier", reason: "alternate data streams" },
	{ path: "\\\\attacker\\share\\a.pdf", reason: "network paths" },
	{ path: "//attacker/share/a.pdf", reason: "network paths" },
	{ path: "\\\\attacker@SSL@443\\DavWWWRoot\\a.pdf", reason: "network paths" },
];
/** Local paths in every spelling a Windows user types: none is refused from the text. */
const WINDOWS_ALLOWED = ["C:\\Work\\a.png", "reports\\a.png", "C:/Work/a.png", "/work/a.png", ".\\a.png"];

describe("textRefusal", () => {
	for (const { path, reason } of WINDOWS_REFUSED) {
		test(`win32 refuses ${path} as ${reason}`, () => {
			const said = textRefusal(path, "win32");
			expect(said, path).toBeString();
			expect(said, path).toContain(reason);
		});
	}

	for (const path of WINDOWS_ALLOWED) {
		test(`win32 allows ${path}`, () => expect(textRefusal(path, "win32")).toBeUndefined());
	}

	test("the Windows spellings are ordinary names elsewhere", () => {
		expect(textRefusal("//host/x", "linux")).toBeUndefined();
		expect(textRefusal("/tmp/a:b.png", "linux")).toBeUndefined();
		expect(textRefusal("/tmp/a:b.png", "darwin")).toBeUndefined();
	});

	for (const platform of ["win32", "linux"] as const) {
		test(`${platform} refuses an empty, blank or NUL-bearing path`, () => {
			expect(textRefusal("", platform)).toContain("empty");
			expect(textRefusal("  \t", platform)).toContain("empty");
			expect(textRefusal("/tmp/a.png\0.txt", platform)).toContain("NUL");
		});
	}
});

describe("the copied text refusal has not drifted from the viewer's", () => {
	// The viewer keeps its empty, NUL and not-absolute refusals inline in `check`, so only the
	// Windows spellings are comparable function to function.
	test("both refuse the same Windows spellings in the same words (the viewer says 'viewable', present 'presentable')", () => {
		for (const path of [...WINDOWS_REFUSED.map(row => row.path), ...WINDOWS_ALLOWED]) {
			const theirs = viewer.textRefusal(path, "win32")?.replace("viewable", "presentable");
			expect(textRefusal(path, "win32"), path).toBe(theirs);
		}
	});

	test("the corpus exercises every rule and both verdicts in the viewer, so agreeing on it means something", () => {
		for (const { path, reason } of WINDOWS_REFUSED) expect(viewer.textRefusal(path, "win32"), path).toContain(reason);
		for (const path of WINDOWS_ALLOWED) expect(viewer.textRefusal(path, "win32"), path).toBeUndefined();
	});

	test("neither refuses a Windows spelling on another platform", () => {
		for (const path of WINDOWS_REFUSED.map(row => row.path)) {
			for (const platform of ["linux", "darwin"] as const) {
				expect(viewer.textRefusal(path, platform), `${platform} ${path}`).toBeUndefined();
				expect(textRefusal(path, platform), `${platform} ${path}`).toBeUndefined();
			}
		}
	});
});

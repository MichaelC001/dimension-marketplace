// Google Workspace connector — read/write Google Sheets, Docs, and Slides over
// the v4/v1 REST APIs, authenticated via the plugin's `oauth` connect flow (see
// fraym.plugin.json). The connect flow writes {access,refresh,expires,clientId,
// clientSecret?} to CONFIG_TARGET; this extension's ONLY job is to keep that
// access token fresh and expose it as agent tools. No Google SDK — plain fetch
// against the documented REST endpoints, matching the sibling google-drive and
// google-calendar connectors.
//
// Spreadsheet/document/presentation IDs come from Drive URLs — the SKILL.md
// teaches extracting the id from a URL and suggests the google-drive plugin to
// FIND the file first (compose, don't duplicate search).
import { readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import type { ToolDefinition } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { type } from "arktype";

// MUST match `connect.configTarget` in fraym.plugin.json — the connect flow
// (packages/engine/src/plugin-oauth.ts) writes the credential there; this is
// the ONLY other place that path is spelled out (JSON manifest can't share a
// TS constant with this file).
const CONFIG_TARGET = join(homedir(), ".config", "dimension-google-workspace", "token.json");
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const SHEETS_API = "https://sheets.googleapis.com/v4/spreadsheets";
const DOCS_API = "https://docs.googleapis.com/v1/documents";
const SLIDES_API = "https://slides.googleapis.com/v1/presentations";
// Refresh this many ms before actual expiry so a slow request never races a
// token that goes stale mid-flight.
const REFRESH_SKEW_MS = 60_000;
// Docs/Slides text can be arbitrarily long; cap what we surface to the agent.
const MAX_TEXT_CHARS = 100_000;

const storedCredential = type({
	"provider?": "string",
	access: "string",
	refresh: "string",
	expires: "number",
	clientId: "string",
	"clientSecret?": "string",
});
type StoredCredential = typeof storedCredential.infer;

async function readCredential(): Promise<StoredCredential> {
	let raw: string;
	try {
		raw = await readFile(CONFIG_TARGET, "utf-8");
	} catch {
		throw new Error(
			"Google Workspace isn't connected yet. Open the plugin's Connect dialog (Plugins → Google Workspace) and sign in.",
		);
	}
	const parsed = storedCredential(JSON.parse(raw));
	if (parsed instanceof type.errors) {
		throw new Error(`Google Workspace's stored credential at ${CONFIG_TARGET} is malformed. Reconnect the plugin.`);
	}
	return parsed;
}

/** Refresh the access token via the standard `refresh_token` grant if it's
 *  expired (or about to be), persisting the renewed credential. Google may not
 *  re-issue a refresh token on every call — the old one is kept when absent. */
async function refreshAccessToken(cred: StoredCredential): Promise<StoredCredential> {
	const body = new URLSearchParams({
		grant_type: "refresh_token",
		refresh_token: cred.refresh,
		client_id: cred.clientId,
	});
	if (cred.clientSecret) body.set("client_secret", cred.clientSecret);
	const res = await fetch(TOKEN_URL, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
		body: body.toString(),
	});
	const payload = (await res.json().catch(() => null)) as Record<string, unknown> | null;
	if (!res.ok || !payload || typeof payload.access_token !== "string") {
		const detail =
			payload && typeof payload.error_description === "string" ? payload.error_description : res.statusText;
		throw new Error(`Google Workspace token refresh failed: ${detail}. Reconnect the plugin.`);
	}
	const expiresIn = typeof payload.expires_in === "number" ? payload.expires_in : 3600;
	const refreshed: StoredCredential = {
		...cred,
		access: payload.access_token,
		refresh: typeof payload.refresh_token === "string" ? payload.refresh_token : cred.refresh,
		expires: Date.now() + expiresIn * 1000,
	};
	await writeFile(CONFIG_TARGET, JSON.stringify(refreshed, null, 2));
	return refreshed;
}

/** A valid bearer token, refreshing first if the stored one is expired/near-expiry. */
async function freshAccessToken(): Promise<string> {
	const cred = await readCredential();
	if (Date.now() < cred.expires - REFRESH_SKEW_MS) return cred.access;
	return (await refreshAccessToken(cred)).access;
}

/** Low-level authenticated fetch against a FULL Workspace API url (the three
 *  APIs live on different hosts, so callers pass absolute urls). */
async function apiFetch(url: string, accessToken: string, init?: RequestInit): Promise<Response> {
	const headers: Record<string, string> = { Authorization: `Bearer ${accessToken}` };
	if (init?.body) headers["Content-Type"] = "application/json";
	const res = await fetch(url, { ...init, headers: { ...headers, ...init?.headers } });
	if (res.status === 401) {
		throw new Error("Google Workspace rejected the access token (401). Reconnect the plugin.");
	}
	return res;
}

async function apiJson<T>(url: string, accessToken: string, op: string, init?: RequestInit): Promise<T> {
	const res = await apiFetch(url, accessToken, init);
	const payload = (await res.json().catch(() => null)) as (T & { error?: { message?: string } }) | null;
	if (!res.ok || !payload) {
		// Surface Google's own error.message verbatim — it names the exact cause
		// (disabled API, bad id, missing scope, invalid range, …).
		throw new Error(`Workspace ${op} failed: ${payload?.error?.message ?? res.statusText}`);
	}
	return payload;
}

// ── Sheets response shapes ──────────────────────────────────────────────────
interface ValueRange {
	readonly range?: string;
	readonly majorDimension?: string;
	readonly values?: readonly (readonly (string | number | boolean)[])[];
}
interface AppendResponse {
	readonly updates?: { readonly updatedRange?: string; readonly updatedRows?: number; readonly updatedCells?: number };
}
interface UpdateResponse {
	readonly updatedRange?: string;
	readonly updatedRows?: number;
	readonly updatedCells?: number;
}
interface SheetProperties {
	readonly sheetId?: number;
	readonly title?: string;
	readonly index?: number;
	readonly gridProperties?: { readonly rowCount?: number; readonly columnCount?: number };
}
interface Spreadsheet {
	readonly spreadsheetId?: string;
	readonly properties?: { readonly title?: string };
	readonly sheets?: readonly { readonly properties?: SheetProperties }[];
}

// ── Docs response shapes ────────────────────────────────────────────────────
interface TextRun {
	readonly content?: string;
}
interface ParagraphElement {
	readonly textRun?: TextRun;
}
interface StructuralElement {
	readonly endIndex?: number;
	readonly paragraph?: { readonly elements?: readonly ParagraphElement[] };
	readonly table?: {
		readonly tableRows?: readonly {
			readonly tableCells?: readonly { readonly content?: readonly StructuralElement[] }[];
		}[];
	};
}
interface GoogleDoc {
	readonly documentId?: string;
	readonly title?: string;
	readonly body?: { readonly content?: readonly StructuralElement[] };
}

// ── Slides response shapes ──────────────────────────────────────────────────
interface SlideTextElement {
	readonly textRun?: { readonly content?: string };
}
interface SlidePageElement {
	readonly objectId?: string;
	readonly shape?: {
		readonly placeholder?: { readonly type?: string };
		readonly text?: { readonly textElements?: readonly SlideTextElement[] };
	};
}
interface Slide {
	readonly objectId?: string;
	readonly pageElements?: readonly SlidePageElement[];
}
interface Presentation {
	readonly presentationId?: string;
	readonly title?: string;
	readonly slides?: readonly Slide[];
}

/** Depth-first flatten of a Docs body to plain text, walking paragraphs and
 *  table cells (which themselves nest structural elements). */
function flattenDoc(elements: readonly StructuralElement[] | undefined): string {
	let out = "";
	for (const el of elements ?? []) {
		if (el.paragraph?.elements) {
			for (const pe of el.paragraph.elements) out += pe.textRun?.content ?? "";
		}
		if (el.table?.tableRows) {
			for (const row of el.table.tableRows) {
				for (const cell of row.tableCells ?? []) out += flattenDoc(cell.content);
			}
		}
	}
	return out;
}

/** The title text of a slide: the first TITLE/CENTERED_TITLE placeholder's text,
 *  else the first shape with any text, else "(untitled)". */
function slideTitle(slide: Slide): string {
	const titled = slide.pageElements?.find(
		el => el.shape?.placeholder?.type === "TITLE" || el.shape?.placeholder?.type === "CENTERED_TITLE",
	);
	const anyText = slide.pageElements?.find(el => el.shape?.text?.textElements?.length);
	const source = titled ?? anyText;
	const text = (source?.shape?.text?.textElements ?? [])
		.map(t => t.textRun?.content ?? "")
		.join("")
		.trim();
	return text || "(untitled)";
}

/** A collision-resistant slides objectId (5–50 chars, [A-Za-z0-9_-], must start
 *  with a letter) for createSlide/insertText requests. */
function newObjectId(prefix: string): string {
	return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

// ── Schemas ─────────────────────────────────────────────────────────────────
const readRangeSchema = type({
	spreadsheetId: type("string").describe(
		"Spreadsheet id — the long token in the Drive/Sheets URL between /d/ and /edit.",
	),
	range: type("string").describe('A1 notation, optionally tab-qualified, e.g. "Sheet1!A1:D20" or "A:A".'),
});

const listTabsSchema = type({
	spreadsheetId: type("string").describe("Spreadsheet id (from the Drive/Sheets URL)."),
});

const appendRowsSchema = type({
	spreadsheetId: type("string").describe("Spreadsheet id (from the Drive/Sheets URL)."),
	range: type("string").describe(
		'A1 range naming the table to append after, e.g. "Sheet1!A1" or "Sheet1!A:D". Append finds the last row of that table.',
	),
	rows: type("string[][]").describe("Rows to append — an array of rows, each an array of cell strings."),
});

const updateRangeSchema = type({
	spreadsheetId: type("string").describe("Spreadsheet id (from the Drive/Sheets URL)."),
	range: type("string").describe('A1 range to OVERWRITE, e.g. "Sheet1!A2:C4". Its cells are replaced by `rows`.'),
	rows: type("string[][]").describe("The new cell values — an array of rows, each an array of cell strings."),
});

const docsReadSchema = type({
	documentId: type("string").describe("Doc id — the long token in the Docs URL between /d/ and /edit."),
});

const docsAppendSchema = type({
	documentId: type("string").describe("Doc id (from the Docs URL)."),
	text: type("string").describe(
		"Text to append at the end of the document. Include a leading \\n to start a new line.",
	),
});

const slidesListSchema = type({
	presentationId: type("string").describe("Presentation id — the long token in the Slides URL between /d/ and /edit."),
});

const slidesAddSlideSchema = type({
	presentationId: type("string").describe("Presentation id (from the Slides URL)."),
	title: type("string").describe("Title text for the new slide."),
	"body?": type("string").describe("Optional body text for the new slide."),
});

// ── Tools ───────────────────────────────────────────────────────────────────
function createSheetsReadRangeTool(): ToolDefinition<typeof readRangeSchema> {
	return {
		name: "sheets_read_range",
		label: "Google Sheets: Read Range",
		description:
			'Read cell values from a spreadsheet by spreadsheetId and A1 range (e.g. "Sheet1!A1:D20"). Get the spreadsheetId from the Drive/Sheets URL; use sheets_list_tabs first if you don\'t know the tab name. Returns the value grid.',
		parameters: readRangeSchema,
		approval: "read" as const,
		async execute(_toolCallId: string, params: typeof readRangeSchema.infer) {
			const accessToken = await freshAccessToken();
			const url = `${SHEETS_API}/${encodeURIComponent(params.spreadsheetId)}/values/${encodeURIComponent(params.range)}`;
			const payload = await apiJson<ValueRange>(url, accessToken, "spreadsheets.values.get");
			const values = payload.values ?? [];
			if (values.length === 0) {
				return { content: [{ type: "text" as const, text: `${payload.range ?? params.range}: (empty)` }] };
			}
			const body = values.map(row => row.map(cell => String(cell ?? "")).join("\t")).join("\n");
			const text = `${payload.range ?? params.range}  (${values.length} rows)\n${body}`;
			return { content: [{ type: "text" as const, text }] };
		},
	};
}

function createSheetsListTabsTool(): ToolDefinition<typeof listTabsSchema> {
	return {
		name: "sheets_list_tabs",
		label: "Google Sheets: List Tabs",
		description:
			"List the sheet (tab) titles, ids, and grid sizes in a spreadsheet. Use this to discover the exact tab name before reading or writing a range.",
		parameters: listTabsSchema,
		approval: "read" as const,
		async execute(_toolCallId: string, params: typeof listTabsSchema.infer) {
			const accessToken = await freshAccessToken();
			const url = `${SHEETS_API}/${encodeURIComponent(params.spreadsheetId)}?fields=properties.title,sheets.properties`;
			const ss = await apiJson<Spreadsheet>(url, accessToken, "spreadsheets.get");
			const sheets = ss.sheets ?? [];
			const lines = sheets.map(s => {
				const p = s.properties ?? {};
				const grid = p.gridProperties;
				const size = grid ? `  ${grid.rowCount ?? "?"}×${grid.columnCount ?? "?"}` : "";
				return `${p.title ?? "(untitled)"}  [id ${p.sheetId ?? "?"}]${size}`;
			});
			const header = `${ss.properties?.title ?? "(untitled spreadsheet)"} — ${sheets.length} tab(s)`;
			const text = sheets.length === 0 ? header : `${header}\n${lines.join("\n")}`;
			return { content: [{ type: "text" as const, text }] };
		},
	};
}

function createSheetsAppendRowsTool(): ToolDefinition<typeof appendRowsSchema> {
	return {
		name: "sheets_append_rows",
		label: "Google Sheets: Append Rows",
		description:
			"Append rows AFTER the last row of a table via values:append (existing data is never overwritten). Mutating — confirm the target spreadsheet, range, and the number of rows with the user first. Returns the range that was written.",
		parameters: appendRowsSchema,
		approval: "write" as const,
		async execute(_toolCallId: string, params: typeof appendRowsSchema.infer) {
			const accessToken = await freshAccessToken();
			if (params.rows.length === 0) throw new Error("No rows to append — pass at least one row.");
			const url = `${SHEETS_API}/${encodeURIComponent(params.spreadsheetId)}/values/${encodeURIComponent(params.range)}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`;
			const payload = await apiJson<AppendResponse>(url, accessToken, "spreadsheets.values.append", {
				method: "POST",
				body: JSON.stringify({ values: params.rows }),
			});
			const u = payload.updates ?? {};
			const text = `Appended ${params.rows.length} row(s) → ${u.updatedRange ?? params.range} (${u.updatedCells ?? "?"} cells).`;
			return { content: [{ type: "text" as const, text }] };
		},
	};
}

function createSheetsUpdateRangeTool(): ToolDefinition<typeof updateRangeSchema> {
	return {
		name: "sheets_update_range",
		label: "Google Sheets: Update Range",
		description:
			"OVERWRITE the cells in an A1 range with new values (values:update). DESTRUCTIVE — this replaces whatever was already in those cells and cannot be undone. Before calling, read the range (sheets_read_range) and confirm the EXACT range and replacement values with the user. Use sheets_append_rows instead when adding new data.",
		parameters: updateRangeSchema,
		approval: "write" as const,
		async execute(_toolCallId: string, params: typeof updateRangeSchema.infer) {
			const accessToken = await freshAccessToken();
			if (params.rows.length === 0) throw new Error("No rows to write — pass at least one row.");
			const url = `${SHEETS_API}/${encodeURIComponent(params.spreadsheetId)}/values/${encodeURIComponent(params.range)}?valueInputOption=USER_ENTERED`;
			const payload = await apiJson<UpdateResponse>(url, accessToken, "spreadsheets.values.update", {
				method: "PUT",
				body: JSON.stringify({ values: params.rows }),
			});
			const text = `Overwrote ${payload.updatedRange ?? params.range} — ${payload.updatedCells ?? "?"} cells (${payload.updatedRows ?? params.rows.length} rows).`;
			return { content: [{ type: "text" as const, text }] };
		},
	};
}

function createDocsReadTool(): ToolDefinition<typeof docsReadSchema> {
	return {
		name: "docs_read",
		label: "Google Docs: Read",
		description:
			"Read a Google Doc by documentId, flattened to plain text (paragraphs and table cells). Get the documentId from the Docs URL. Truncated past ~100K chars.",
		parameters: docsReadSchema,
		approval: "read" as const,
		async execute(_toolCallId: string, params: typeof docsReadSchema.infer) {
			const accessToken = await freshAccessToken();
			const url = `${DOCS_API}/${encodeURIComponent(params.documentId)}`;
			const doc = await apiJson<GoogleDoc>(url, accessToken, "documents.get");
			const flat = flattenDoc(doc.body?.content);
			const truncated = flat.length > MAX_TEXT_CHARS;
			const body = truncated ? `${flat.slice(0, MAX_TEXT_CHARS)}\n[...truncated at ${MAX_TEXT_CHARS} chars]` : flat;
			const text = `${doc.title ?? "(untitled doc)"}\n\n${body}`;
			return { content: [{ type: "text" as const, text }] };
		},
	};
}

function createDocsAppendTool(): ToolDefinition<typeof docsAppendSchema> {
	return {
		name: "docs_append",
		label: "Google Docs: Append",
		description:
			"Append text to the END of a Google Doc via batchUpdate insertText. Mutating — confirm the text with the user first. Include a leading newline in `text` if you want it on its own line.",
		parameters: docsAppendSchema,
		approval: "write" as const,
		async execute(_toolCallId: string, params: typeof docsAppendSchema.infer) {
			const accessToken = await freshAccessToken();
			if (params.text.length === 0) throw new Error("No text to append.");
			// endIndex of the last structural element is the doc's end; inserting at
			// endIndex-1 lands the text just before the final newline segment.
			const doc = await apiJson<GoogleDoc>(
				`${DOCS_API}/${encodeURIComponent(params.documentId)}?fields=title,body.content.endIndex`,
				accessToken,
				"documents.get",
			);
			const content = doc.body?.content ?? [];
			const lastEnd = content.reduce((max, el) => Math.max(max, el.endIndex ?? 0), 1);
			const insertAt = Math.max(1, lastEnd - 1);
			const url = `${DOCS_API}/${encodeURIComponent(params.documentId)}:batchUpdate`;
			await apiJson<unknown>(url, accessToken, "documents.batchUpdate", {
				method: "POST",
				body: JSON.stringify({
					requests: [{ insertText: { location: { index: insertAt }, text: params.text } }],
				}),
			});
			const text = `Appended ${params.text.length} char(s) to "${doc.title ?? params.documentId}".`;
			return { content: [{ type: "text" as const, text }] };
		},
	};
}

function createSlidesListTool(): ToolDefinition<typeof slidesListSchema> {
	return {
		name: "slides_list",
		label: "Google Slides: List Slides",
		description:
			"List the slides in a presentation — object id, 1-based index, and title text per slide. Get the presentationId from the Slides URL. Use a slide's object id with slides_add_slide's context.",
		parameters: slidesListSchema,
		approval: "read" as const,
		async execute(_toolCallId: string, params: typeof slidesListSchema.infer) {
			const accessToken = await freshAccessToken();
			const url = `${SLIDES_API}/${encodeURIComponent(params.presentationId)}?fields=title,slides(objectId,pageElements(objectId,shape(placeholder,text)))`;
			const pres = await apiJson<Presentation>(url, accessToken, "presentations.get");
			const slides = pres.slides ?? [];
			const lines = slides.map((s, i) => `${i + 1}. ${slideTitle(s)}  [${s.objectId ?? "?"}]`);
			const header = `${pres.title ?? "(untitled presentation)"} — ${slides.length} slide(s)`;
			const text = slides.length === 0 ? header : `${header}\n${lines.join("\n")}`;
			return { content: [{ type: "text" as const, text }] };
		},
	};
}

function createSlidesAddSlideTool(): ToolDefinition<typeof slidesAddSlideSchema> {
	return {
		name: "slides_add_slide",
		label: "Google Slides: Add Slide",
		description:
			"Add a slide with a title (and optional body) to a presentation via batchUpdate — creates a TITLE_AND_BODY slide and inserts the text. Mutating — confirm the title and body with the user first. Returns the new slide's object id.",
		parameters: slidesAddSlideSchema,
		approval: "write" as const,
		async execute(_toolCallId: string, params: typeof slidesAddSlideSchema.infer) {
			const accessToken = await freshAccessToken();
			const slideId = newObjectId("slide");
			const titleId = newObjectId("title");
			const bodyId = newObjectId("body");
			// createSlide with mapped placeholder ids so the follow-up insertText
			// requests can target the title/body shapes in the SAME batch.
			const requests: unknown[] = [
				{
					createSlide: {
						objectId: slideId,
						slideLayoutReference: { predefinedLayout: "TITLE_AND_BODY" },
						placeholderIdMappings: [
							{ layoutPlaceholder: { type: "TITLE", index: 0 }, objectId: titleId },
							{ layoutPlaceholder: { type: "BODY", index: 0 }, objectId: bodyId },
						],
					},
				},
				{ insertText: { objectId: titleId, text: params.title } },
			];
			if (params.body) requests.push({ insertText: { objectId: bodyId, text: params.body } });
			const url = `${SLIDES_API}/${encodeURIComponent(params.presentationId)}:batchUpdate`;
			await apiJson<unknown>(url, accessToken, "presentations.batchUpdate", {
				method: "POST",
				body: JSON.stringify({ requests }),
			});
			const text = `Added slide "${params.title}"${params.body ? " (with body)" : ""}  [${slideId}]`;
			return { content: [{ type: "text" as const, text }] };
		},
	};
}

/**
 * Google Workspace plugin. A standard OMP plugin — `skills/`/`rules/` load via
 * OMP's native plugin discovery. This module registers the eight read/write
 * tools; the connect flow (fraym.plugin.json's `connect.oauth`) is what obtains
 * and refreshes the credential these tools read.
 */
export default function googleWorkspaceExtension(pi: ExtensionAPI): void {
	pi.registerTool(createSheetsReadRangeTool());
	pi.registerTool(createSheetsListTabsTool());
	pi.registerTool(createSheetsAppendRowsTool());
	pi.registerTool(createSheetsUpdateRangeTool());
	pi.registerTool(createDocsReadTool());
	pi.registerTool(createDocsAppendTool());
	pi.registerTool(createSlidesListTool());
	pi.registerTool(createSlidesAddSlideTool());
}

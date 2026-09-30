// What plugin.json promises the host the viewer can open, held to what the viewer
// really draws and really annotates. The host decides a click from the published
// rows alone (`pickHandler`, `annotationModelFor`), so the promise is checked
// through the host's own functions, not a restatement of them.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	ARTIFACT_ANNOTATION_MODELS,
	ARTIFACTORY_GRANT_FILES_READ,
	type ArtifactOpen,
	type ArtifactoryDecl,
	validateArtifactoryDecl,
} from "@dimension/sdk/artifactory";
import { type AnnotationModel, annotationModelFor, classifyFile, type OpenHandlerFact, pickHandler } from "@dimension/sdk/presentation";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { z } from "zod";
import type { ViewerKind } from "../src/contract";
import { detectKind } from "../src/kind";
import { createViewerServer } from "../src/server";

const manifest = JSON.parse(readFileSync(new URL("../plugin.json", import.meta.url), "utf8"));
const declaration = manifest.extensions["ai.insodimension.dimension"].artifactories[0];
const decl: ArtifactoryDecl = { ...declaration, plugin: manifest.name, type: "artifactory" };
const opens: readonly ArtifactOpen[] = decl.opens ?? [];

/** The rows the engine publishes for this declaration (`artifactory/opens`), first-party as the bundled pack is. */
const rows: OpenHandlerFact[] = opens.map(open => ({
	plugin: decl.plugin,
	server: `${decl.plugin}/${decl.mcpServer}`,
	label: open.label,
	firstParty: true,
	tool: open.tool,
	pathArg: open.pathArg ?? "path",
	nameArg: open.nameArg,
	ext: open.ext ?? [],
	mime: open.mime ?? [],
	annotates: open.annotates ?? [],
}));

/** What the View's annotate layer does per kind it draws (doc 85; `annotationModes` in `app/view/pane-extras.tsx`):
 *  marks on a picture, comments on text, nothing on a page drawn in a script-less frame or a file card. */
const VIEW_ANNOTATES: Record<ViewerKind, AnnotationModel | null> = {
	image: "marks",
	pdf: "text",
	docx: "text",
	pptx: "text",
	xlsx: "text",
	markdown: "text",
	text: "text",
	html: null,
	binary: null,
};

const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const ZIP = [0x50, 0x4b, 0x03, 0x04];
const ascii = (text: string) => Array.from(text, char => char.charCodeAt(0));
/** The first bytes a real file of this extension starts with, where it has a signature. */
function headOf(ext: string): Uint8Array {
	const bytes: Record<string, number[]> = {
		png: PNG,
		jpg: [0xff, 0xd8, 0xff, 0xe0],
		jpeg: [0xff, 0xd8, 0xff, 0xe0],
		gif: ascii("GIF89a"),
		webp: [...ascii("RIFF"), 0, 0, 0, 0, ...ascii("WEBP")],
		avif: [0, 0, 0, 0x1c, ...ascii("ftypavif")],
		bmp: ascii("BM"),
		ico: [0, 0, 1, 0],
		pdf: ascii("%PDF-1.7"),
		docx: ZIP,
		pptx: ZIP,
		xlsx: ZIP,
		xlsm: ZIP,
	};
	return new Uint8Array(bytes[ext] ?? ascii("plain text\n"));
}

describe("the declaration", () => {
	test("passes the SDK's validator, so a bad entry fails here and not at engine load", () => {
		expect(validateArtifactoryDecl(decl)).toEqual([]);
	});

	test("asks for the files:read grant, without which the host lends the viewer no file", () => {
		expect(decl.grants).toContain(ARTIFACTORY_GRANT_FILES_READ);
	});

	test("every entry names a public tool of the real server that takes the declared path and name arguments", async () => {
		const base = await mkdtemp(join(tmpdir(), "viewer-manifest-"));
		try {
			await writeFile(join(base, "index.html"), "<!doctype html><title>viewer</title>");
			const server = await createViewerServer({ viewDir: base });
			const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
			const client = new Client({ name: "test", version: "0" });
			await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
			const { tools } = await client.listTools();
			await client.close();
			const visibility = z.object({ ui: z.object({ visibility: z.array(z.string()).optional() }) });
			for (const row of rows) {
				const tool = tools.find(candidate => candidate.name === row.tool);
				expect(tool, `${row.tool} is a tool of the server`).toBeDefined();
				expect(visibility.parse(tool?._meta).ui.visibility ?? ["model", "app"]).toContain("model");
				expect(Object.keys(tool?.inputSchema.properties ?? {})).toContain(row.pathArg);
				// A pasted screenshot is staged under a hash; `filename` is what titles its tab instead.
				expect(row.nameArg, `${row.tool} declares the argument a display name goes in`).toBeDefined();
				expect(Object.keys(tool?.inputSchema.properties ?? {})).toContain(row.nameArg as string);
			}
			// The argument `openWith` adds for the Annotate action is one this tool takes.
			expect(Object.keys(tools.find(tool => tool.name === "view_file")?.inputSchema.properties ?? {})).toContain("annotate");
		} finally {
			await rm(base, { recursive: true, force: true });
		}
	});

	test("every annotation model it names is one the platform defines", () => {
		for (const open of opens) for (const model of open.annotates ?? []) expect(ARTIFACT_ANNOTATION_MODELS).toContain(model);
	});
});

describe("what the viewer claims to open is what it draws and what it can annotate", () => {
	const claimed = rows.flatMap(row => row.ext.map(ext => ({ row, ext })));

	test("each entry is one family: its extensions are drawn as the same kind of document", () => {
		for (const row of rows) {
			const kinds = new Set(row.ext.map(ext => detectKind(`file.${ext}`, headOf(ext))));
			expect(kinds.size, `${row.ext.join(",")} drawn as ${[...kinds].join(",")}`).toBe(1);
		}
	});

	test.each(claimed.map(({ ext }) => ext))("%s: the viewer draws it (not a bare file card), and declares what the View can annotate for it", ext => {
		const row = claimed.find(candidate => candidate.ext === ext)?.row as OpenHandlerFact;
		const kind = detectKind(`file.${ext}`, headOf(ext));
		expect(kind).not.toBe("binary");
		const model = VIEW_ANNOTATES[kind];
		expect(row.annotates).toEqual(model === null ? [] : [model]);
	});

	test.each(claimed.map(({ ext }) => ext))("%s: a click on it reaches the viewer, and the host offers Annotate exactly when the View can", ext => {
		const file = classifyFile(`report.${ext}`, headOf(ext));
		const row = pickHandler(rows, { name: `report.${ext}`, mime: file.mime });
		expect(row?.plugin).toBe("viewer");
		const offered = (() => {
			const hostModel = annotationModelFor(file.kind);
			return hostModel !== null && row?.annotates.includes(hostModel) === true;
		})();
		const viewModel = VIEW_ANNOTATES[detectKind(`report.${ext}`, headOf(ext))];
		// Offered only when the model the host asks for is the one the View implements.
		expect(offered).toBe(viewModel !== null && viewModel === annotationModelFor(file.kind));
	});

	test("the mime a data source or a tool reports for a known extension is declared beside it", () => {
		for (const { row, ext } of claimed) {
			const named = classifyFile(`x.${ext}`);
			if (named.kind !== "binary") expect(row.mime, `${ext} is ${named.mime}`).toContain(named.mime);
		}
	});

	test("audio, video, archives and binaries are not claimed: the viewer would only show a file card", () => {
		for (const name of ["a.mp3", "a.wav", "a.mp4", "a.mov", "a.zip", "a.tar", "a.gz", "a.7z", "a.exe", "a.dll", "a.bin", "a.doc", "a.xls"]) {
			const file = classifyFile(name);
			expect(pickHandler(rows, { name, mime: file.mime }), name).toBeUndefined();
		}
	});
});

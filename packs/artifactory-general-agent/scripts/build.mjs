import { mkdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build as buildServer } from "esbuild";
import { build as buildView } from "vite";
import react from "@vitejs/plugin-react";
import { validateArtifactoryDecl } from "@dimension/sdk/artifactory";
import { validateRailActionDecl } from "@dimension/sdk/rail-action";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// Agent Plugins 1.0.0 layout: the pack id is the portable `name`; the
// Dimension declaration lives under the `ai.insodimension.dimension` extension.
const manifest = JSON.parse(await readFile(resolve(root, "plugin.json"), "utf8"));
const declared = manifest.extensions?.["ai.insodimension.dimension"]?.artifactories;
if (!Array.isArray(declared) || declared.length === 0) throw new Error("plugin.json declares no artifactories");
for (const declaration of declared) {
  const issues = validateArtifactoryDecl({ ...declaration, plugin: manifest.name, type: "artifactory" });
  if (issues.length) throw new Error(issues.map(issue => issue.message).join("\n"));
}
// The door: each rail entry must be one the engine accepts, and must seat a server
// THIS pack hosts as an App — the engine drops an entry that does not.
const servers = declared.map(declaration => declaration.mcpServer);
for (const rail of manifest.extensions?.["ai.insodimension.dimension"]?.railActions ?? []) {
  const issues = validateRailActionDecl(rail);
  if (issues.length) throw new Error(issues.map(issue => `railActions[${rail.id}]: ${issue.message}`).join("\n"));
  const seated = rail.session?.artifactory?.server;
  if (seated !== undefined && !servers.includes(seated)) throw new Error(`railActions[${rail.id}] seats "${seated}", which this pack does not host (${servers.join(", ")})`);
}
// The runtime `dependencies` stay external (installed beside the pack); the
// SDK's `parseGeneralAgent` — a workspace package not published to npm, with
// the fork's manifest parser behind it — is BUNDLED, so the installed server
// classifies agents with exactly the code the engine does.
const pkg = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
await mkdir(resolve(root, "app"), { recursive: true });
await buildServer({
  entryPoints: [resolve(root, "src/stdio.ts")],
  outfile: resolve(root, "app/server.mjs"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  external: Object.keys(pkg.dependencies),
  sourcemap: false,
});
await buildView({
  configFile: false,
  root: resolve(root, "app/view"),
  base: "./",
  plugins: [react()],
  // ONE React: `@modelcontextprotocol/ext-apps/react` must call the hooks of the
  // same copy that renders the View, wherever the installer put either.
  resolve: { dedupe: ["react", "react-dom"] },
  build: { outDir: resolve(root, "app/dist"), emptyOutDir: true, sourcemap: false, target: "es2022" },
});

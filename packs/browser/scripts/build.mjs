import { mkdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build as buildServer } from "esbuild";
import { build as buildView } from "vite";
import react from "@vitejs/plugin-react";
import { validateArtifactoryDecl } from "@dimension/sdk/artifactory";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(await readFile(resolve(root, "dimension.plugin.json"), "utf8"));
for (const declaration of manifest.artifactories) {
  const issues = validateArtifactoryDecl({ ...declaration, plugin: manifest.plugin, type: "artifactory" });
  if (issues.length) throw new Error(issues.map(issue => issue.message).join("\n"));
}
await mkdir(resolve(root, "app"), { recursive: true });
await buildServer({
  entryPoints: [resolve(root, "src/stdio.ts")],
  outfile: resolve(root, "app/server.mjs"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  packages: "external",
  sourcemap: false,
});
await buildView({
  configFile: false,
  root: resolve(root, "app/view"),
  base: "./",
  plugins: [react()],
  build: { outDir: resolve(root, "app/dist"), emptyOutDir: true, sourcemap: false, target: "es2022" },
});

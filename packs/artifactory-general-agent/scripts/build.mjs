import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { build } from "vite";

// The View bundle only. The pack's MCP server (agent_open + app-only agent
// tools) is the next slice of the Forge epic and lands its own build step here.
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
await build({
	configFile: false,
	root: resolve(root, "app/view"),
	base: "./",
	plugins: [react()],
	build: { outDir: resolve(root, "app/dist"), emptyOutDir: true, sourcemap: false, target: "es2022" },
});

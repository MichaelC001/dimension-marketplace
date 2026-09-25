import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Dev server for the Forge View on its own (preview mode, seeded agents).
// The shipped bundle is built by scripts/build.mjs with the same root.
export default defineConfig({
	root: "app/view",
	base: "./",
	plugins: [react()],
	server: { port: 5197, strictPort: true },
	build: { outDir: "../dist", emptyOutDir: true, target: "es2022" },
});

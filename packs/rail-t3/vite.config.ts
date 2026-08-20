import { defineConfig } from "vite";

// The rung-3 bundle: a pack ships a BUILT ESM bundle the host loads at
// runtime, so nothing in the app references this pack by name. The externals
// list IS the capability boundary (doc 68 §9.1 Q1) - exactly what the host's
// import map grants, nothing else. Unminified on purpose: `dist/` is
// committed, so it has to stay reviewable.
export default defineConfig({
	build: {
		target: "es2022",
		minify: false,
		sourcemap: false,
		emptyOutDir: true,
		lib: {
			entry: "src/index.ts",
			formats: ["es"],
			fileName: () => "index.mjs",
		},
		rollupOptions: {
			external: ["react", "react-dom", "react/jsx-runtime", "@fraym/ui"],
		},
	},
});

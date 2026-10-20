import { defineConfig } from "vite";

export default defineConfig({
	esbuild: { jsx: "automatic" },
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

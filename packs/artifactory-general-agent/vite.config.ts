// The General Agents View builds to `app/dist/` in the App kit's shape (the
// same config every Dimension App's View uses: React, Tailwind over
// `@fraym/ui`, relative URLs, one React). `bun run dev` serves it on its own —
// preview mode, seeded agents, nothing written (`app/view/preview.ts`).
import { defineAppViteConfig } from "@dimension/mcp-app-kit/vite";

const config = defineAppViteConfig({ appDir: `${__dirname}/app` });
export default { ...config, server: { port: Number(process.env.FORGE_PREVIEW_PORT ?? 5197), strictPort: true } };

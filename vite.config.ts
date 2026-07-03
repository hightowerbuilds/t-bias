import { defineConfig } from "vite";
import solid from "vite-plugin-solid";

// SolidJS SPA. Deno's main.ts serves the built `dist/` (and the /api + /ws
// backend bridge) in production; in browser dev you can also run `bun run dev`.
export default defineConfig({
  plugins: [solid()],
  build: { outDir: "dist", target: "esnext", emptyOutDir: true },
  server: { port: 5173 },
});

import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

/**
 * The web app is static: it stands in for the publicly hosted UI and talks to
 * `nod serve` (:4518) directly from the browser, so there is no proxy here.
 *
 * The dev server and the preview forbid framing by header, as the named host
 * does (`src/server/static-files.ts`). The hosted UI cannot: GitHub Pages
 * takes no header config, and a `<meta>` CSP cannot carry `frame-ancestors`.
 * There the app refuses by itself (`src/web/lib/guard.ts`, ADR 0005 §7).
 */
const NO_FRAMING = {
  "X-Frame-Options": "DENY",
  "Content-Security-Policy": "frame-ancestors 'none'",
};

export default defineConfig({
  root: "src/web",
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { "@": new URL("./src/web", import.meta.url).pathname },
  },
  server: {
    port: Number(process.env.PORT) || 4517,
    strictPort: true,
    fs: { allow: [import.meta.dirname] },
    headers: NO_FRAMING,
  },
  preview: { headers: NO_FRAMING },
  build: { outDir: "../../dist/web", emptyOutDir: true },
});

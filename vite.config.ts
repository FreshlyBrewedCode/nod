import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

/**
 * The web app is static: it stands in for the publicly hosted UI and talks to
 * `nod serve` (:4518) directly from the browser, so there is no proxy here.
 */
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
  },
  build: { outDir: "../../dist/web", emptyOutDir: true },
});

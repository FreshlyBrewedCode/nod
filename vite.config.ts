import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";

import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

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

/** Every file under `dir`, as paths relative to it with `/`. */
function filesUnder(dir: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => relative(dir, join(entry.parentPath, entry.name)).split("\\").join("/"));
}

/**
 * The service worker (ADR 0008 §7): `src/web/sw.ts` built as `/sw.js`, with
 * the build id and the list of the build's files written into it, and the
 * same id into `index.html` as `<meta name="nod-build">`. The id is a hash of
 * every file of the build but those two, so any change to the app is a new
 * worker and a new cache, and the page can tell which build it is.
 */
function serviceWorker(): Plugin {
  let publicDir = "";
  return {
    name: "nod-service-worker",
    apply: "build",
    configResolved(config) {
      publicDir = config.publicDir;
    },
    buildStart() {
      this.emitFile({
        type: "chunk",
        id: new URL("./src/web/sw.ts", import.meta.url).pathname,
        fileName: "sw.js",
      });
    },
    generateBundle: {
      // After Vite's own HTML plugin has emitted `index.html`.
      order: "post",
      handler(_, bundle) {
        const sw = bundle["sw.js"];
        const index = bundle["index.html"];
        if (sw?.type !== "chunk" || index?.type !== "asset")
          throw new Error(`no sw.js or index.html in ${Object.keys(bundle).join(", ")}`);
        const hash = createHash("sha256");
        const built = Object.keys(bundle)
          .filter((name) => name !== "sw.js" && name !== "index.html" && !name.endsWith(".map"))
          .sort();
        for (const name of built) {
          const file = bundle[name]!;
          hash.update(name).update(file.type === "chunk" ? file.code : file.source);
        }
        const copied = publicDir ? filesUnder(publicDir).sort() : [];
        for (const name of copied) hash.update(name).update(readFileSync(join(publicDir, name)));
        const build = hash.digest("hex").slice(0, 16);
        const precache = [...built, ...copied];
        if (!sw.code.includes("__NOD_BUILD__") || !sw.code.includes("__NOD_PRECACHE__"))
          throw new Error("sw.js lost its placeholders");
        sw.code = sw.code
          .replaceAll("__NOD_BUILD__", JSON.stringify(build))
          .replaceAll("__NOD_PRECACHE__", JSON.stringify(precache));
        index.source = String(index.source).replace(
          "</head>",
          `  <meta name="nod-build" content="${build}" />\n  </head>`,
        );
      },
    },
  };
}

export default defineConfig({
  root: "src/web",
  plugins: [react(), tailwindcss(), serviceWorker()],
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

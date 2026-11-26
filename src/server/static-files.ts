/**
 * The built web app, served by `nod serve` itself when it answers to a named
 * host (ADR 0005): page and socket then share one origin, so no browser's
 * local network rules apply and the version of the page is the CLI's. A
 * single-page app: every path that is not a file is `index.html`.
 */

import { existsSync } from "node:fs";
import { join, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The web app this CLI ships: the package's `web/` (staged by
 * `scripts/build-release.ts`), else a checkout's `dist/web` (`bun run
 * build`). Either way the build of this very version.
 */
export function defaultWebRoot(): string {
  const packaged = fileURLToPath(new URL("../../web", import.meta.url));
  if (existsSync(join(packaged, "index.html"))) return packaged;
  return fileURLToPath(new URL("../../dist/web", import.meta.url));
}

/** Whether `root` holds a built web app. */
export function isWebRoot(root: string): boolean {
  return existsSync(join(root, "index.html"));
}

/**
 * The file under `root` a request path names, or `null` for a path that
 * leaves `root` or is not a plain file path (the caller then serves
 * `index.html`).
 */
export function staticFile(root: string, pathname: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (decoded.includes("\0") || decoded.includes("\\") || decoded.split("/").includes(".."))
    return null;
  const relative = normalize(decoded).replace(/^\/+/, "");
  if (relative === "" || relative === ".") return null;
  const file = join(root, relative);
  return file.startsWith(root.endsWith(sep) ? root : `${root}${sep}`) ? file : null;
}

/**
 * Headers for every page and asset: no framing (the sign button must not be
 * clickjacked), no sniffing, no referrer (a deep link names a repo and PR).
 */
export const STATIC_HEADERS: Readonly<Record<string, string>> = {
  "X-Frame-Options": "DENY",
  "Content-Security-Policy": "frame-ancestors 'none'",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
};

/** Serve `pathname` from `root`, falling back to `index.html`. */
export async function serveStatic(root: string, pathname: string): Promise<Response> {
  const file = staticFile(root, pathname);
  if (file) {
    const asset = Bun.file(file);
    if (await asset.exists()) {
      const immutable = pathname.startsWith("/assets/");
      return new Response(asset, {
        headers: {
          ...STATIC_HEADERS,
          "Cache-Control": immutable ? "public, max-age=31536000, immutable" : "no-cache",
        },
      });
    }
  }
  const index = Bun.file(join(root, "index.html"));
  if (!(await index.exists())) return new Response("the web app is not built", { status: 404 });
  return new Response(index, {
    headers: { ...STATIC_HEADERS, "Content-Type": "text/html", "Cache-Control": "no-cache" },
  });
}

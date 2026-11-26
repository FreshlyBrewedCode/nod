import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { serveStatic, staticFile } from "./static-files";

const root = mkdtempSync(join(tmpdir(), "nod-static-"));
mkdirSync(join(root, "assets"));
writeFileSync(join(root, "index.html"), "<!doctype html><title>nod</title>");
writeFileSync(join(root, "assets", "app-1.js"), "console.log(1)");
writeFileSync(join(tmpdir(), "nod-static-outside.txt"), "outside");
afterAll(() => rmSync(root, { recursive: true, force: true }));

test("a request path maps to a file under the root, never outside it", () => {
  expect(staticFile(root, "/assets/app-1.js")).toBe(join(root, "assets", "app-1.js"));
  expect(staticFile(root, "/a%20b.js")).toBe(join(root, "a b.js"));
  for (const path of [
    "/",
    "/..",
    "/../nod-static-outside.txt",
    "/assets/../../x",
    "/%2e%2e/x",
    "/%2e%2e%2fx",
    "/a\\b",
    "/a%00b",
    "/%E0%A4%A",
  ])
    expect(staticFile(root, path)).toBeNull();
});

test("files are served, anything else is the app's index", async () => {
  const asset = await serveStatic(root, "/assets/app-1.js");
  expect(await asset.text()).toBe("console.log(1)");
  expect(asset.headers.get("cache-control")).toContain("immutable");
  expect(asset.headers.get("x-frame-options")).toBe("DENY");
  for (const path of ["/", "/pr/acme/widgets/7", "/../nod-static-outside.txt"]) {
    const page = await serveStatic(root, path);
    expect(await page.text()).toContain("<title>nod</title>");
    expect(page.headers.get("content-security-policy")).toBe("frame-ancestors 'none'");
  }
});

test("the home-screen files are served with their types (the built app's own)", async () => {
  const built = new URL("../web/public/", import.meta.url).pathname;
  const types: Record<string, string> = {
    "/manifest.webmanifest": "application/manifest+json",
    "/apple-touch-icon.png": "image/png",
    "/icon-192.png": "image/png",
    "/icon-512.png": "image/png",
    "/icon-maskable-512.png": "image/png",
    "/icon.svg": "image/svg+xml",
  };
  for (const [path, type] of Object.entries(types)) {
    const response = await serveStatic(built, path);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toStartWith(type);
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  }
  const manifest = await (await serveStatic(built, "/manifest.webmanifest")).json();
  expect(manifest).toMatchObject({ name: "nod", display: "standalone", start_url: "./" });
  for (const icon of manifest.icons as { src: string }[])
    expect((await serveStatic(built, `/${icon.src}`)).headers.get("content-type")).not.toBe(
      "text/html",
    );
});

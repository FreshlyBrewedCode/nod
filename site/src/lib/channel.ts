/*
 * The docs come in two channels, like the package and its web app: `latest`
 * at the root documents the stable release, `next` under `/next` documents
 * `main`, i.e. the pre-release. One build is one channel, picked by
 * `DOCS_CHANNEL`; `scripts/build-channels.sh` builds both and nests them.
 * Unset, a build is `latest` at the root, so `bun run dev` and `bun run build`
 * behave as they always have.
 *
 * Where the site itself is served is a second, independent setting: the
 * domain root (`nod.frebreco.de`, and every local build) or a folder of
 * another origin (a GitHub project page, `freshlybrewedcode.github.io/nod`).
 * `SITE_BASE` is that folder and `SITE_ORIGIN` the origin; both channels sit
 * under it (`/nod`, `/nod/next`). The deploy workflow takes them from
 * `actions/configure-pages`, so the build follows the Pages settings and a
 * custom domain needs no code change.
 *
 * Read at build time only (config, frontmatter, endpoints), never in the
 * browser, so plain `process.env` rather than Vite's `PUBLIC_` variables.
 */

/** A path prefix as the rest of this file wants it: `/nod`, or empty at the root. */
const prefix = (value: string | undefined) => {
  const path = (value ?? "").trim().replace(/^\/+|\/+$/g, "");
  return path ? `/${path}` : "";
};

/** The folder the whole site is served from, without a trailing slash; empty at a domain root. */
export const SITE_BASE = prefix(process.env.SITE_BASE);

/** The origin the site is served from, for canonical and absolute URLs. */
export const SITE_ORIGIN = (process.env.SITE_ORIGIN || "https://nod.frebreco.de").replace(/\/+$/, "");

export type Channel = "latest" | "next";

interface ChannelInfo {
  /** What the version picker calls it. */
  label: string;
  /** Path prefix, `SITE_BASE` included, without a trailing slash; empty at a domain root. */
  base: string;
  /** The release it documents, e.g. `0.5.0`, when the build was told. */
  version?: string;
}

export const CHANNELS: Record<Channel, ChannelInfo> = {
  latest: { label: "Stable", base: SITE_BASE, version: process.env.DOCS_LATEST_VERSION || undefined },
  next: { label: "Next", base: `${SITE_BASE}/next`, version: process.env.DOCS_NEXT_VERSION || undefined },
};

export const CHANNEL: Channel = process.env.DOCS_CHANNEL === "next" ? "next" : "latest";

/** This build's path prefix, for every root-relative link it emits. */
export const BASE = CHANNELS[CHANNEL].base;

/** A root-relative path (`/docs/policy`) as this channel serves it. */
export const href = (path: string) => BASE + path;

/**
 * Docs text as this channel's reader should run it: on `next`, the package is
 * `@frebreco/nod@next` (never the subpath `@frebreco/nod/kit`: that is an
 * import, not an install). Applied to code in the rendered pages
 * (`markdown-channel.ts`) and to the raw markdown, so a copied command
 * installs what the page describes.
 *
 * The web app's URL is left alone: the CLI opens its own channel's web app by
 * itself (`src/server/web-url.ts`), and the deep links the docs show are the
 * verifier's, which always point at the stable one.
 */
export function forChannel(text: string): string {
  if (CHANNEL !== "next") return text;
  return text.replace(/@frebreco\/nod(?![@\w/-])/g, "@frebreco/nod@next");
}

/** A root-relative link in docs markdown (`/docs/policy`), pointed into this channel. */
export function linkForChannel(url: string): string {
  return url.startsWith("/docs") ? href(url) : url;
}

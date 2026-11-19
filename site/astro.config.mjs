// @ts-check
import { satteri } from "@astrojs/markdown-satteri";
import tailwind from "@tailwindcss/vite";
import { defineConfig } from "astro/config";
import expressiveCode from "astro-expressive-code";
import { BASE } from "./src/lib/channel.ts";
import { markdownChannel } from "./src/lib/markdown-channel.ts";

export default defineConfig({
  site: "https://nod.frebreco.de",

  // `/next` for the `next` channel's docs, the root otherwise — see
  // `src/lib/channel.ts`. Astro wants a trailing-slash-free base or `/`.
  base: BASE || "/",

  // Docs markdown names the package, the web app and other pages; point them
  // at this build's channel.
  markdown: { processor: satteri({ mdastPlugins: [markdownChannel] }) },

  // No `redirects` entry for `/docs`. On static hosting Astro can only compile
  // one into a meta-refresh stub, and an unstyled stub paints white before it
  // bounces. `pages/docs/[...slug].astro` renders the entry page at `/docs`
  // instead — same destination, no flash.

  // Expressive Code's own options live in `ec.config.mjs` — see the note there.
  integrations: [expressiveCode()],

  // 4517 is the web app's Vite dev server and 4518 `nod serve`; the site takes
  // the next port, for `astro dev` and `astro preview` alike.
  server: { port: Number(process.env.PORT) || 4519 },

  vite: { plugins: [tailwind()] },
});

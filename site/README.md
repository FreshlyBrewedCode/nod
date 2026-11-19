# site

The landing page and docs for nod, served at `https://freshlybrewedcode.github.io/nod/` until the
custom domain `nod.frebreco.de` is set. Astro 7 (static output),
Tailwind v4, Expressive Code for codeblocks, Pagefind for search. The docs machinery is copied
from the sibling project canvas's site; the landing page is nod's own.

Its own package with its own `node_modules` and `bun.lock`, not part of the root package. The
root `bun run check` does not cover it; CI builds it in its own `site` job.

```bash
cd site
bun install

bun run dev      # http://localhost:4519, no search (see below)
bun run build    # astro build, then pagefind indexes dist/
bun run preview  # build + serve dist/ on :4519: the only way to test search locally
bun run build:channels  # what CI deploys: stable at /, main under /next (see Channels)
bun run check    # astro check (types across .astro files)
```

`astro preview` runs in the background: `bunx astro preview stop` ends it.

On NixOS, run `build`, `build:channels` and `preview` inside `nix develop` (from the repo root):
Astro's image pipeline, sharp, needs `libstdc++`, which the dev shell provides.

## Layout

| Path                                 | What it is                                                           |
| ------------------------------------ | -------------------------------------------------------------------- |
| `content/docs/*.md`                  | Docs prose. Frontmatter: `title`, `description?`, `section`, `order` |
| `content/docs/screenshots/`          | Screenshots the docs embed (see Screenshots)                         |
| `src/content.config.ts`              | The `docs` collection: glob loader + zod schema                      |
| `src/pages/index.astro`              | Landing page: one sentence, the product shown, three points          |
| `src/components/landing/Demo.astro`  | A slice of the dashboard rebuilt in HTML, in four states             |
| `src/styles/landing.css`             | The landing page's layout, the demo's rows and its states            |
| `src/scripts/landing.ts`             | Steps the demo through its states; nothing else                      |
| `src/pages/docs/[...slug].astro`     | One route per markdown file                                          |
| `src/pages/docs/[...slug].md.ts`     | The same pages as raw markdown at `/docs/<slug>.md`                  |
| `src/pages/docs/index.md.ts`         | Unlisted markdown index of every doc                                 |
| `src/lib/docs.ts`                    | `sortedDocs()`: sidebar order, shared by the above                   |
| `src/lib/sections.ts`                | The sidebar sections, in order                                       |
| `src/lib/channel.ts`                 | Where a build is served and which channel it is: base, `href()`      |
| `src/lib/markdown-channel.ts`        | Points markdown's code and `/docs` links at the channel              |
| `src/components/VersionPicker.astro` | Stable/next badge and menu, above the page outline                   |
| `scripts/build-channels.sh`          | Builds both channels into one `dist/`                                |
| `src/components/NavDrawer.astro`     | Mobile nav: trigger bar + drawer, below `lg`                         |
| `src/styles/global.css`              | Tailwind entry + design tokens + prose and Pagefind theming          |
| `ec.config.mjs`                      | Expressive Code themes and style overrides                           |

## Adding a page

Drop a `.md` file in `content/docs/`. It appears at `/docs/<filename>` and in the sidebar, under its
`section`, sorted by `order`. Nothing else to register.

Keep titles to a word or two, and use the terms of the Glossary page (`content/docs/glossary.md`):
nod, signer, policy, classifier, finding, rule, requirement, verifier, check, summary, FYI, batch,
ask, attention tier, and so on. Add a term there before using a new one. The docs say "pull
request", not "PR", except in names the product uses ("setup PR").

Every command, flag, file name and behaviour in the docs must match the code on `main`: take
commands from `bun src/cli.ts --help` and snippets from `templates/`. Where something is not
released, the docs say so and give the from-source way.

## The landing page

Dark only, like the app, in the app's own tokens (the r3 palette of `src/web/styles.css`, repeated
in `landing.css`). One column on the header's left edge, a lot of air between its blocks and few
words: a sentence under the headline, the frame, three points of a sentence each, the limit, the
commands. There is no margin column of labels; what the frame needs said is one caption line. The demo is one picture in four states, set by `data-step` on the frame; the CSS
draws every state and `landing.ts` only changes the attribute. It plays while on screen, stops for
good when the reader clicks a step or Pause, and never starts by itself under
`prefers-reduced-motion`. The frame is an illustration (`role="img"`); the steps below it are the
controls. Its people and repository are the app's fake data (`src/server/fake-data.ts`): fictional,
and they have to stay that way.

## Screenshots

Copies of the implementation screenshots in `docs/design/r3/impl/`, cropped to their content and
stored as lossless WebP. They show the fake team of `nod serve --fake`. There is no screenshot
pipeline: when the app changes, retake the ones in `docs/design/r3/impl/` as that folder describes
and convert the few the docs use (sharp: `.webp({ lossless: true })`).

## Raw markdown

Append `.md` to any docs URL (`/docs/introduction.md`) for the source without the chrome. The doc
header links it, and `src/pages/docs/[...slug].md.ts` generates it as a static file alongside the
HTML. Served as `text/plain` so browsers display it rather than downloading; frontmatter is stripped
and the `title` and `description` are reinstated as an H1 and a lead paragraph.

`/docs/index.md` lists every page in sidebar order with its description, each linking to its `.md`
source: fetch one URL to learn what exists, then fetch what you need. It is unlisted: not a
collection entry, so the sidebar never shows it, and Pagefind only indexes HTML, so search ignores
it. Its links are absolute, built from `site` in `astro.config.mjs`, which is `SITE_ORIGIN` (see
Base path).

## Channels

The docs come in the package's two channels. The root (`/docs`) documents the stable release,
`@frebreco/nod`; `/next/docs` documents `main`, the pre-release `@frebreco/nod@next`. A badge above
the page outline says which, and its menu goes to the same page in the other channel (or that
channel's `/docs`, when the page does not exist there).

One build is one channel, set by environment variables that `src/lib/channel.ts` reads:

| Variable                                   | What it does                                         |
| ------------------------------------------ | ---------------------------------------------------- |
| `DOCS_CHANNEL`                             | `latest` (default, at `/`) or `next` (under `/next`) |
| `DOCS_CONTENT`                             | Where the markdown is, instead of `content/docs`     |
| `DOCS_LATEST_VERSION`, `DOCS_NEXT_VERSION` | The versions the badge shows; left out when unset    |

`scripts/build-channels.sh` builds both into one `dist/`. Only `content/` comes from the last
stable tag, extracted to `.stable/`; the site around it, the landing page included, is the
checkout's, so a fix to a layout or a style reaches both channels at once. On `next`,
`markdown-channel.ts` turns `@frebreco/nod` in code into `@frebreco/nod@next` (never the import
`@frebreco/nod/kit`) and points `/docs/…` links under `/next`; the raw `.md` pages get the same. A
root-relative link in a component goes through `href()`.

## Base path

The site is served either from a domain root (`nod.frebreco.de`, and every local build) or from a
folder of another origin: as a GitHub project page it is `https://freshlybrewedcode.github.io/nod/`.
Two more variables say which, read by `src/lib/channel.ts` like the channel's:

| Variable      | What it does                                                            |
| ------------- | ----------------------------------------------------------------------- |
| `SITE_BASE`   | The folder, `/nod`; empty (the default) at a domain root                |
| `SITE_ORIGIN` | The origin for canonical and absolute URLs; `https://nod.frebreco.de` by default |

Both channels sit under the base (`/nod/`, `/nod/next/`). It reaches everything through one place:
`CHANNELS[…].base` and `href()` carry it, Astro's `base` is built from it (so the bundled CSS, JS,
fonts and images follow), and so do the Pagefind bundle path, the favicon, the version picker, the
raw `.md` routes and the links in the docs markdown. So **never write a root-relative URL by hand**
in a component or a stylesheet: `href("/docs/policy")`, not `"/docs/policy"`. Docs markdown keeps
writing `/docs/…`; `markdown-channel.ts` rewrites it.

`dist/` looks the same with and without a base: it is what gets mounted at the folder. To try a
prefixed build, serve `dist/` under the prefix (`astro preview` serves one channel, not the nested
two):

```bash
SITE_BASE=/nod SITE_ORIGIN=https://freshlybrewedcode.github.io bun run build:channels
# then any static server that mounts dist/ at /nod, on :4519
```

CI builds the site this way on every PR.

**Before the first stable release** there is no tag to take the stable content from (and a tag
older than this site has no `site/content/`). The script then builds both channels from the
checkout and the badge shows no stable version, so the root is never empty. From the first stable
tag that contains `site/content/docs` on, the root is that tag's content.

So a docs change merged to `main` shows under `/next` straight away and at the root with the next
stable release, including a fix to a page stable already has. Pages under `/next` are `noindex`.

## Deploying

`.github/workflows/site.yml` builds both channels and deploys `dist/` to the nod repo's GitHub
Pages after every run of the release workflow (which every push to `main` starts, and which moves
the stable content when it publishes `latest`), or by hand from the Actions tab. Both its jobs are
skipped until the repository variable `SITE_ENABLED` is `true`: its own switch, apart from the
releases' `RELEASE_ENABLED`. `docs/release.md` has the owner's checklist (Pages on the repo, the
switch, later the DNS record and the custom domain).

The workflow asks `actions/configure-pages` where Pages serves the repo and builds for that
(`SITE_ORIGIN`, `SITE_BASE`): the project page `https://freshlybrewedcode.github.io/nod/` first,
`https://nod.frebreco.de/` once the custom domain is set in the Pages settings and the workflow has
run again. The custom domain is that setting only; nothing in the code names it as the place of
deployment. The web app is not part of this site: it is served from `ui.nod.frebreco.de` by the
release workflow.

## Things that will bite you

- **Rendered markdown is cached across channels.** The content layer cache (below) keys a page on
  its source, and the two channels render the same source differently, so `build-channels.sh`
  builds with `--force`. The next channel's Pagefind is its own index under `/next/pagefind/`;
  `Search.astro` names that bundle, as the component UI otherwise finds the root's.
- **Search is build-only.** Pagefind indexes rendered HTML in `dist/`, so `astro dev` has no index.
  The header shows a "build only" chip there instead of a dead search box. Use `bun run preview`.
- **Expressive Code options live in `ec.config.mjs`,** not `astro.config.mjs`. The `<Code>` component
  needs options it can serialise to JSON, and `themeCssSelector` is a function.
- **Tailwind v4 puts everything in `@layer`, and unlayered CSS beats every layer** regardless of
  specificity; and separately, two unlayered rules of _equal_ specificity still just fall to source
  order. Third-party stylesheets here are unlayered, so they quietly win either way. Instances: the
  `.prose` token bindings (unlayered to beat `@layer utilities`), the Pagefind `--pf-*` block and
  the Expressive Code copy-button size (both `.foo.foo`-doubled), and hiding `<pagefind-searchbox>`
  responsively (Tailwind's `hidden` loses to Pagefind's element selector, so the breakpoint classes
  live on a wrapper div instead). `landing.css` is unlayered on purpose and scoped under `.landing`.
  When a utility class inexplicably does nothing to a third-party element, this is why.
- **Editing `ec.config.mjs` (or anything else that changes how markdown renders, without touching
  any `.md` file) can 404 the Expressive Code stylesheet, in dev _and_ in a build.** Astro's
  content layer caches each doc's rendered HTML, keyed only on the source markdown's digest. The
  cache then reuses the old HTML, `<link>` to the old theme's hash and all, while Expressive Code
  emits only the new hash's file. `bun run dev` runs `dev:clean` first; for a build:

  ```bash
  bun run dev:clean   # or: rm -f .astro/data-store.json node_modules/.astro/data-store.json
  ```

- **`astro check` needs TypeScript 6.** TS 7 (tsgo, what the root package pins) does not expose the
  programmatic API the Astro language server uses, so this package pins `typescript@^6` locally.
- **A description with a colon breaks the frontmatter.** Quote it, or reword it.

## Not done yet

- Design tokens are copied from `src/web/styles.css` rather than shared (twice: `global.css` under
  the site's names, `landing.css` under the app's). Lift them into one file once both surfaces
  settle.
- The docs' light scheme is the site's own; the app has none.
- No `.astro` formatter. oxfmt does not parse the format, and the root `bun run check` does not
  cover this package.

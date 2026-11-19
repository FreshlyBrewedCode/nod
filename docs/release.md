# Release

The same setup as the sibling project canvas: semantic-release, two channels, the web app on a
separate Pages repo, the site on this repo's Pages. **The one-time setup below is done**: the
`@frebreco` npm org and package with its trusted publisher, the `nod-ui` repo and its deploy key,
both Pages sites on their custom domains, the DNS records, and both switches (`RELEASE_ENABLED`,
`SITE_ENABLED`) are on. The checklist stays as the record of how it was set up and how to redo it.

## How it works

- PRs are squash-merged and the **PR title is the conventional commit** semantic-release reads
  (`pr-title.yml` checks it). `feat` is a minor, `fix`/`perf` a patch, a breaking change is
  also a minor while the version is 0.x (`.releaserc.json`).
- Two channels, one workflow (`.github/workflows/release.yml`):
  - **next**: every push to `main` publishes `@frebreco/nod@X.Y.Z-next.N` on the npm `next`
    dist-tag plus a GitHub pre-release, and deploys the web app to `ui.nod.frebreco.de/next`.
  - **latest**: running `release` by hand (Actions, "Run workflow") publishes `X.Y.Z` on `latest`
    and deploys the web app to the root of `ui.nod.frebreco.de`.
- `release.yml` calls `ui.yml`, which builds the web app **from the release's tag** (so it matches
  the published CLI's `src/shared/protocol.ts`) and pushes it to the `FreshlyBrewedCode/nod-ui`
  repo, whose GitHub Pages serve `ui.nod.frebreco.de`. Stable goes to the root, next to `next/`.
  `ui.yml` can also be run by hand to redeploy a released version.
- The npm package is staged by `scripts/build-release.ts` into `dist/npm/nod/`. The repo's own
  `package.json` is `"private": true`, so only the staged manifest can ever be published. It
  contains `bin/nod.js` (the Bun guard and launcher), `src/cli.ts`, `src/server/`, `src/shared/`
  and `src/kit/`, as raw TypeScript (Bun runs it). The web app is **not** in the package. The
  subpath export `@frebreco/nod/kit` points at `./src/kit/index.ts`, which a consumer running Bun
  (the repo-owned verifier) imports as is. Only the dependencies the staged sources import go
  in the manifest.
- The staging step stamps the version into the staged `package.json` and into the
  `const VERSION = "0.0.0-development";` line of the staged `src/cli.ts` (staging fails if that
  line is gone). `--smoke-test` installs the staged package into a scratch directory laid out like
  a registry install and checks: Node is rejected with "requires Bun", `--version` prints the
  stamped version, `@frebreco/nod/kit` resolves for a consumer, `nod init`'s templates render,
  and the channel URLs. CI runs it with `0.0.0-development` on every PR.
- The published CLI opens the web app of its own channel. `src/server/web-url.ts` must export
  `STABLE_WEB_URL = "https://ui.nod.frebreco.de"`, `NEXT_WEB_URL` (the stable URL plus `/next`),
  `DEV_WEB_URL = "http://localhost:4517"` and `defaultWebUrl(version: string | undefined)`: no
  version gives the dev URL, a version with a `-` suffix gives next, otherwise stable. The server
  reads the version from the `package.json` the staging step stamped; the repo's own manifest has
  none, which means a checkout and the Vite dev server. The smoke test fails if the file is missing.
- The site (the landing page and the docs, `site/`) has its own workflow, `site.yml`, as in
  canvas, and its own switch (below). It runs after every run of `release`, skipped ones included,
  and by hand; it builds both docs channels with `site/scripts/build-channels.sh` and deploys
  `site/dist` to **this repo's** GitHub Pages with `actions/deploy-pages`. The root documents the
  last stable tag's `site/content/`, `/next` documents `main`. Before the first stable release
  that has docs, both channels are built from `main`, and the version picker shows no stable
  version. CI builds the site on every PR (the `site` job, under the `/nod` base); it is its own
  package and the root `bun run check` does not touch it. See `site/README.md`.
- Where the site is served is a Pages setting, not code. Until the custom domain is set it is the
  project page **`https://freshlybrewedcode.github.io/nod/`** (docs of `main` under `/nod/next/`);
  with the custom domain it is `https://nod.frebreco.de/`. `site.yml` asks
  `actions/configure-pages` for the origin and the base path and passes them to the build as
  `SITE_ORIGIN` and `SITE_BASE` (`site/src/lib/channel.ts`); unset, as in a local build, they are
  `https://nod.frebreco.de` and the root.

## What switches it on

`vars.RELEASE_ENABLED == 'true'` gates the `release` job, the `ui` job of `release.yml` and the
`deploy` job of `ui.yml`. Unset, a merge to `main` shows them as skipped and stays green.
Switch on: `gh variable set RELEASE_ENABLED --body true --repo FreshlyBrewedCode/nod`.
Switch off again: `gh variable delete RELEASE_ENABLED --repo FreshlyBrewedCode/nod`.

`vars.SITE_ENABLED == 'true'` gates both jobs of `site.yml`, and nothing else: the site can be
deployed while the releases stay off. Its first deploy also needs Pages enabled on this repo with
"GitHub Actions" as the source. All of it (step 4 below):

```
gh api --method POST repos/FreshlyBrewedCode/nod/pages -f build_type=workflow
gh variable set SITE_ENABLED --body true --repo FreshlyBrewedCode/nod
gh workflow run site.yml --repo FreshlyBrewedCode/nod --ref main
```

Switch off again: `gh variable delete SITE_ENABLED --repo FreshlyBrewedCode/nod`.

## Owner checklist

In this order. `scripts/bootstrap-release.sh` automates the GitHub parts; it prints each step and
asks `[y/N]` before doing it, so it can be run phase by phase
(`scripts/bootstrap-release.sh <github|ui|site|dns|npm|trusted-publishers|enable>`). Its
prompts need a terminal; an agent doing the setup runs the same commands one by one instead.

1. **npm organisation.** Make sure the `@frebreco` org exists: https://www.npmjs.com/org/create
   (the script checks with `npm org ls frebreco`).
2. **GitHub setup** (`scripts/bootstrap-release.sh github`): creates the `release` environment
   (the OIDC subject npm trusts), requires the `check` status check and squash-merge only on
   `main`, creates the `stable` branch (`.releaserc.json` needs a non-prerelease branch) and tags
   `v0.1.0` at `main` as the 0.x floor.
3. **The `nod-ui` Pages repo and the deploy key** (`scripts/bootstrap-release.sh ui`): creates the
   public `FreshlyBrewedCode/nod-ui`, seeds `main` with `CNAME` and `.nojekyll`, enables Pages
   from `main /`, sets the custom domain `ui.nod.frebreco.de`, generates an ed25519 key, adds the
   public half to `nod-ui` as a write deploy key, stores the private half as the `UI_DEPLOY_KEY`
   secret of `nod`. By hand, the same:
   ```
   gh repo create FreshlyBrewedCode/nod-ui --public
   ssh-keygen -t ed25519 -N "" -f key
   gh repo deploy-key add key.pub --repo FreshlyBrewedCode/nod-ui --allow-write
   gh secret set UI_DEPLOY_KEY --repo FreshlyBrewedCode/nod < key
   ```
4. **The site** (`scripts/bootstrap-release.sh site`; independent of every other step, so it can
   be done first): enables GitHub Pages on `FreshlyBrewedCode/nod` itself with **GitHub Actions**
   as the source (`site.yml` deploys with `actions/deploy-pages`; there is no Pages branch), sets
   `SITE_ENABLED` and runs `site.yml`. By hand: Settings, Pages, Source "GitHub Actions"; then the
   variable and "Run workflow" on `site`. Or:
   ```
   gh api --method POST repos/FreshlyBrewedCode/nod/pages -f build_type=workflow
   gh variable set SITE_ENABLED --body true --repo FreshlyBrewedCode/nod
   gh workflow run site.yml --repo FreshlyBrewedCode/nod --ref main
   ```
   The first deploy creates the `github-pages` environment; nothing to set up there. The site is
   then at `https://freshlybrewedcode.github.io/nod/`: check the landing page, `/nod/docs`,
   `/nod/next/docs` and the search.
5. **DNS** at wherever the `frebreco.de` zone lives (`scripts/bootstrap-release.sh dns` prints
   them):
   ```
   CNAME  ui.nod  ->  freshlybrewedcode.github.io
   CNAME  nod     ->  freshlybrewedcode.github.io
   ```
   Then re-run the `ui` phase (or tick "Enforce HTTPS" in its Pages settings) once GitHub has
   issued the certificate.

   **Verify the domain** for the GitHub account, so no one else can point a Pages site at a
   subdomain of it: account Settings, Pages, "Add a domain" `frebreco.de` (the apex covers every
   subdomain), add the TXT record `_github-pages-challenge-FreshlyBrewedCode` it shows, then
   "Verify". Web UI only; the REST API has no endpoint for it.

   **The site's custom domain, later**: once the `nod` record resolves, set the custom domain
   (Settings, Pages, Custom domain `nod.frebreco.de`; or re-run the `site` phase, which does it
   only when the name resolves) and run `site.yml` once more, so the site is rebuilt for the
   domain root. No code change: the build follows the Pages settings.
   ```
   gh api --method PUT repos/FreshlyBrewedCode/nod/pages -f cname=nod.frebreco.de
   gh workflow run site.yml --repo FreshlyBrewedCode/nod --ref main
   gh api --method PUT repos/FreshlyBrewedCode/nod/pages -F https_enforced=true   # once the certificate is there
   ```
   Not before the record exists: with the domain set, GitHub redirects the project page to it.
   `https://freshlybrewedcode.github.io/nod/` then redirects to `https://nod.frebreco.de/`.
6. **npm package name** (`scripts/bootstrap-release.sh npm`): needs `npm login` and npm >= 11.5.1.
   npm only lets you attach a trusted publisher to a package that exists, and CI has no token,
   so this publishes a `0.0.1` placeholder of `@frebreco/nod` by hand, once. (Alternative to
   trusted publishing: an automation token as `NPM_TOKEN` secret, passed as `NPM_TOKEN` env to
   the two `semantic-release` steps. Trusted publishing is preferred: nothing to leak or rotate.)
   With a passkey as npm's second factor, `npm publish` signs in through the browser and so has to
   run in the owner's own terminal; without one it fails with `EOTP`. The registry can take a
   couple of minutes to show a new package, and npm adds a `0.0.0-stage` version of its own (for
   staged publishing, on no dist-tag).
7. **npm trusted publisher** (`scripts/bootstrap-release.sh trusted-publishers`): on
   https://www.npmjs.com/package/@frebreco/nod/access, Trusted Publisher, GitHub Actions:
   organization `FreshlyBrewedCode`, repository `nod`, workflow filename `release.yml`,
   environment `release`; tick the "npm publish" allowed action. A mistake here shows up later as
   an opaque 404 or 422 in the first release.
8. **Switch it on** (`scripts/bootstrap-release.sh enable`):
   `gh variable set RELEASE_ENABLED --body true --repo FreshlyBrewedCode/nod`.
9. **First run.** The next merge to `main` with a releasable commit (`feat`, `fix`, `perf`;
   `docs` and `chore` release nothing) publishes a `0.1.1-next.1`-style pre-release and deploys `ui.nod.frebreco.de/next`. Check
   `npm view @frebreco/nod dist-tags`, the `nod-ui` commit `deploy: <version>`, and
   `bunx @frebreco/nod@next --version`. For the first stable release: Actions, `release`,
   "Run workflow" on `main`; then `ui.nod.frebreco.de` serves the root build.
   `site` runs after each `release` run and redeploys the site, so the docs' version picker shows
   the new versions (to deploy it without a release: Actions, `site`, "Run workflow"). Then update the docs pages that say nothing is released yet
   (`site/content/docs/quick-start.md`, `status.md`, `introduction.md`, `cli.md`) and the landing
   page's "Try it".

If a release job fails after the tag exists, fix the cause and run `ui` by hand with that version
to redeploy; do not delete tags semantic-release made.

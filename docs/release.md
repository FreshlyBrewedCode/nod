# Release

The same setup as the sibling project canvas: semantic-release, two channels, the web app on a
separate Pages repo. **It is prepared but switched off**: nothing below has been created yet
(no npm package, no `nod-ui` repo, no deploy key, no DNS, no secrets), and every publishing
workflow is skipped until the repository variable `RELEASE_ENABLED` is `true`.

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
  stamped version, `@frebreco/nod/kit` resolves for a consumer, and (once it exists) the channel
  URLs. CI runs it with `0.0.0-development` on every PR.
- The published CLI opens the web app of its own channel. `src/server/web-url.ts` must export
  `STABLE_WEB_URL = "https://ui.nod.frebreco.de"`, `NEXT_WEB_URL` (the stable URL plus `/next`),
  `DEV_WEB_URL = "http://localhost:4517"` and `defaultWebUrl(version: string | undefined)`: no
  version gives the dev URL, a version with a `-` suffix gives next, otherwise stable. The server
  reads the version from the `package.json` the staging step stamped; the repo's own manifest has
  none, which means a checkout and the Vite dev server. Staging tolerates the file being absent.
- The site (`nod.frebreco.de`) is **not part of this pipeline**: there is no site yet, so no
  `site.yml`. When it exists it gets its own workflow, as in canvas.

## What switches it on

`vars.RELEASE_ENABLED == 'true'` gates the `release` job, the `ui` job of `release.yml` and the
`deploy` job of `ui.yml`. Unset, a merge to `main` shows them as skipped and stays green.
Switch on: `gh variable set RELEASE_ENABLED --body true --repo FreshlyBrewedCode/nod`.
Switch off again: `gh variable delete RELEASE_ENABLED --repo FreshlyBrewedCode/nod`.

## Owner checklist

In this order. `scripts/bootstrap-release.sh` automates the GitHub parts; it prints each step and
asks `[y/N]` before doing it, so it can be run phase by phase
(`scripts/bootstrap-release.sh <github|ui|dns|npm|trusted-publishers|enable>`). It has not been run.

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
4. **DNS** at wherever the `frebreco.de` zone lives (`scripts/bootstrap-release.sh dns` prints
   them):
   ```
   CNAME  ui.nod  ->  freshlybrewedcode.github.io
   CNAME  nod     ->  freshlybrewedcode.github.io   (only once the site exists; none yet)
   ```
   Then re-run the `ui` phase (or tick "Enforce HTTPS" in the `nod-ui` Pages settings) once
   GitHub has issued the certificate.
5. **npm package name** (`scripts/bootstrap-release.sh npm`): needs `npm login` and npm >= 11.5.1.
   npm only lets you attach a trusted publisher to a package that exists, and CI has no token,
   so this publishes a `0.0.1` placeholder of `@frebreco/nod` by hand, once. (Alternative to
   trusted publishing: an automation token as `NPM_TOKEN` secret, passed as `NPM_TOKEN` env to
   the two `semantic-release` steps. Trusted publishing is preferred: nothing to leak or rotate.)
6. **npm trusted publisher** (`scripts/bootstrap-release.sh trusted-publishers`): on
   https://www.npmjs.com/package/@frebreco/nod/access, Trusted Publisher, GitHub Actions:
   organization `FreshlyBrewedCode`, repository `nod`, workflow filename `release.yml`,
   environment `release`; tick the "npm publish" allowed action. A mistake here shows up later as
   an opaque 404 or 422 in the first release.
7. **Switch it on** (`scripts/bootstrap-release.sh enable`):
   `gh variable set RELEASE_ENABLED --body true --repo FreshlyBrewedCode/nod`.
8. **First run.** The next merge to `main` (or "Re-run" of its `release` run) publishes
   `0.1.0-next.1`-style pre-release and deploys `ui.nod.frebreco.de/next`. Check
   `npm view @frebreco/nod dist-tags`, the `nod-ui` commit `deploy: <version>`, and
   `bunx @frebreco/nod@next --version`. For the first stable release: Actions, `release`,
   "Run workflow" on `main`; then `ui.nod.frebreco.de` serves the root build.

If a release job fails after the tag exists, fix the cause and run `ui` by hand with that version
to redeploy; do not delete tags semantic-release made.

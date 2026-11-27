nod

- a local-first dashboard that steers a team's attention across agent-written PRs, plus a signed
  human attestation (a "nod") on GitHub so agents can merge on their own
- local: runs on your machine with your `gh` credentials, shared state lives in GitHub; the
  policy and verifier live in the user's own repo (`.nod/`), not in this package
- prototype stage: proving the concept (`docs/concept.md`), not hardening it
- two halves
  1. **`nod serve`** (`src/cli.ts`, `src/server/`): local Bun server, polls GitHub, holds the
     signing key, one token-guarded WebSocket used only by the user's own browser
  2. **web app** (`src/web/`): Vite/React SPA; the app is the build `nod serve` serves itself at
     `http://127.0.0.1:<port>/` (ADR 0008), the hosted UI stays for deep links, Vite dev server
     locally
- `src/shared/protocol.ts` is the wire contract of both halves (protocol 2: many repos, ADR 0007;
  a repo is its repo key `owner/name` or `host/owner/name`, a PR is (repo, number), in the web
  app the PR id `<repo key>#<n>`, both in `src/shared/repo-key.ts`); `src/kit/` is the pure helper
  kit the repo-owned verifier imports as `@frebreco/nod/kit`
- `templates/` is what `nod init` (`src/init/`) writes into a user's repo: `.nod/policy.ts`,
  `.nod/classifiers/`, `.nod/verify.ts`, `allowed_signers`, the kit pin and
  `.github/workflows/nod.yml`. They are shipped in the npm package, typechecked, linted and run
  in `src/init/templates.test.ts` (`@frebreco/nod/kit` maps to `src/kit/` via `tsconfig.json`);
  the workflow follows finding 01's hygiene rules, enforced by `setup-files.test.ts`
- the sandbox `FreshlyBrewedCode/nod-sandbox` (public) runs the real setup; findings 01 and 02
  describe its state
- kit: zero dependencies; nod format, patch-id and file list via `git`, SSHSIG via `ssh-keygen`
  (argument arrays, never a shell), classifiers, policy, check summary, sticky comment, REST helpers;
  everything exported has a doc comment; tests use real `git`/`ssh-keygen` in temp dirs, never `~/.ssh`

- stack (sibling: `../canvas`)
  - bun, TypeScript, React 19, Vite, tailwind v4, shadcn-style primitives; design system in
    `docs/design/design.md` (r3 mockups win on layout)
  - oxlint, oxfmt

- working in this repo
  - `bun run check` = format:check + lint + typecheck + test; CI runs it plus `bun run build`
  - dev: `bun run dev` (Vite on :4517) and `nod serve` (:4518, `bun src/cli.ts serve`); after
    `bun run build`, `nod serve` also serves `dist/web` on its own port and prints that link second
    (a release prints it first, `printedLinks` in `cli.ts`)
    - `bun src/cli.ts serve --fake [--scenario team|clear|first-run|fresh|join|inbox|shared|repos|dir]
      [--frozen]`: the mockup's team in memory (`src/server/fake-*.ts`); open the printed host
      link. Fake passphrase: anything but `wrong`. `repos`: three repos at three ladder steps,
      one on `acme.ghe.com` (`fake-repos.ts`, where the team are managed users and I am
      `mara_acme`: logins are per host); `fresh`: an empty repo list; `dir`: `team` as a
      fixed list (`--dir`); every other scenario reads one repo. The fake's list is managed:
      add (a name with `missing` is not found, `private` forbidden), remove, suggestions
    - the pairing token is stable under `$XDG_CONFIG_HOME/nod/serve-token`; pass `--token-file`
      to keep tests and experiments out of it
    - against GitHub: `bun src/cli.ts serve --dir <a clone of the repo> [--poll 60]`, or the
      repo list (`bun src/cli.ts repo add <[host/]owner/name>`, then `serve` outside a clone);
      `NOD_DEBUG=1` logs each poll's queries and GraphQL cost. Experiments use a throwaway
      `XDG_CONFIG_HOME` (key and token) and then need `GH_CONFIG_DIR` pointing at the real gh
      config, or `gh auth token` finds no login. Finding 03 is the sandbox run
  - server seams: `Source` (`src/server/source.ts`: one source knows every repo, each method
    that touches one takes its repo key, `repos()` lists them, each with my login on its host
    (`SourceRepo.login`, `RepoInfo.login`: a nod's `reviewer`, "your own PR"; the web app's
    `meIn(pr)`, not `snapshot.me`, for anything on one PR); the session groups a batch by
    repo and signs one payload per repo with `Signer.signLines`; `fake-source.ts` has a
    `FakeRepo` per repo; `github-source.ts` reads the repo list (`config.ts`,
    `$XDG_CONFIG_HOME/nod/config.json`) or, as the clone override (`--dir`, or an empty list in
    a clone), one clone, with its parts in `src/server/github/`: `repo.ts` (one repo's cache and
    rows), `host.ts` (one host's API, login, rate limit and its one `Poll` query for all its
    repos, a block `r<i>` each, `REPOS_PER_QUERY`), the `GitHubApi` seam with an injectable
    `fetch` (`graphqlPartial`: one repo's error does not fail the host), the queries, `map.ts`
    (GraphQL PR + the verifier's summary → `PrFacts`, never classifies), the brief parser,
    `clone.ts` (patch-ids in the user's clone or nod's own blobless bare one under
    `$XDG_CACHE_HOME/nod/clones/`), `suggest.ts` (what one may type for a repo, suggestions),
    setup and enrolment; `nod repo add|remove|list` is `repo-cli.ts`; tests run on
    `github/fake-github.ts`, one fake per host with any number of repos (`repo(name)`), and
    temp XDG dirs: never `~/.config/nod` or `~/.cache/nod`), `Signer`
    (`signer.ts`: the seam, the unlock window and the fake), `view.ts` turns a source's `PrFacts` into the user-relative view model;
    `src/shared/attention.ts` is the pure layout logic (tiers, lanes, buckets, board, the repo
    filter `inRepo` and `repoBoardView`) the UI
    renders; the web app talks only through `useConnection` (`src/web/hooks/`)
  - web app: `app.tsx` gates on the connection (calm full pages) and mounts
    `components/dashboard.tsx` (list state, keyboard, resizable panel); rows in
    `pr-row.tsx`, panel in `detail-panel.tsx`; pure helpers with tests in `src/web/lib/`
    (route, focus, selection, panel width, time, diff bar, wording); theme tokens (the r3
    palette) in `styles.css`; one ticking clock (`hooks/use-clock.ts`). The board
    (`board.tsx`, group by Waiting on, State or, with several repos, Repository) opens the same
    panel as a 540 px overlay drawer. With several repos the repo filter (`repo-filter.tsx`, in
    the sub-bar and the board bar; `nod.repoFilter`, `readRepoFilter`) narrows list, board,
    selection and the offer card to one repo. With several repos rows, cards, the panel and the sheet carry a repo chip
    (`RepoChip`, `chipsOf` in `lib/repos.ts`, which also has the enrolment helpers: the lock
    chip takes the best of all repos, a batch the worst of its own); with one, the top bar names
    it and there is no chip. Every way to sign calls `openBatch(prIds)` (`components/batch-dialog.tsx`):
    review, unlock in place, signed / stale / posting failed, the steps a pure state machine
    in `lib/batch.ts`; without an active key the asks are `approve` and the same dialog posts
    GitHub approvals (request `approve`, review → approving → approved, one kind per batch;
    `--fake --scenario inbox`, and `join` at a set-up repo); the passphrase only ever lives in
    its input (`components/unlock.tsx`, also the lock chip). Screenshots of it: `docs/design/r3/impl/`
  - settings (`#/settings[/<section>]`, `components/settings.tsx`, words in `lib/settings.ts`):
    a section nav and its sections, Repositories (rows with host, step, my key, the next offer,
    "The ladder ›" to `#/setup/<repo>`, Remove; `AddRepo` in `add-repo.tsx` with
    `suggest-repos`) and App (install, the badge switch; ADR 0008); a new section is its id in
    `SETTINGS_SECTIONS` (`lib/route.ts`), its words in `SECTIONS`, its page in `SECTION_PAGES`. Requests `add-repo` (`parseRepoInput` in
    `shared/repo-key.ts`), `remove-repo`, `suggest-repos`; `welcome.repoList` `managed|fixed`
    (fixed: read-only, the session refuses changes); a list change pushes `repos` before the
    snapshot, and a request's `repos` push comes before its reply
  - onboarding is offers, not a gate (ADR 0006): `app.tsx` shows a calm page only while `gh` is
    not logged in or the repo list is empty ("Add a repository", `add-repo.tsx`), then the
    dashboard. The ladder's next step for this repo
    and me is one dismissible card above the list (`components/offer.tsx`; "Not now" is kept per
    viewer in `nod.offers`), every step offered is in the avatar menu, and the steps are done on
    the setup page `#/setup[/<repo>][/<step>]` (`components/onboarding.tsx`, the ladder; with
    several repos it names one and leads back to Settings → Repositories). All of it is derived from server state only
    (`lib/onboarding.ts`, tested per fake scenario) and takes one repo (`RepoInfo`: setup with
    `permission`, my enrolment there) and my signer; the card is the first repo's next step,
    named, and "Not now" brings up no other repo's. Deep links (`components/link-landing.tsx`,
    `lib/deep-link.ts`): `#/pr/<owner>/<repo>/<n>` and `#/batch/<owner>/<repo>/<n>,<n>` (kit:
    `prDeepLink`, `batchDeepLink`) only open views; a link opened before pairing is remembered
    and the host link lands on it (`rememberLink`/`takeLink` in `lib/connection.ts`). The host
    link may carry a route: `#/pr/…?host=…&token=…`. A repo off github.com puts its GitHub host
    first: `#/pr/<host>/<owner>/<repo>/<n>`, `#/batch/<host>/<owner>/<repo>/…`; a link without
    one is a github.com link, and the landing compares host and repo with `welcome.github`
  - GitHub hosts (github.com, `<name>.ghe.com`, GHES; `docs/enterprise.md`): the host comes from
    the clone's `origin`, once (`--host` overrides; an ssh alias needs it), and
    `src/kit/host.ts` is the only place that knows the endpoint shapes. The token is
    `gh auth token --hostname <host>` and goes only to that host's API (`fetchWithToken`,
    redirects included); `nod init` runs every `gh` with `GH_HOST` and `--hostname`. Tests: the
    fake GitHub plays a host (`new FakeGitHub(githubHost("acme.ghe.com"))`) and answers only its
    URL shapes (`misdirected`). Fictional hosts only: `acme.ghe.com`, `git.example.test`
  - another device (ADR 0005, finding 04): `--allow-host <name[:port]>` (`named-host.ts`) adds one
    named host behind a TLS proxy (`tailscale serve`); the server serves the built web app there
    (`static-files.ts`, `dist/web` or the package's `web/`), and that side has its own token
    (`serve-token-remote`, `<--token-file>-remote`) and its own unlock window (`Side` in
    `signer.ts`, `Client.side` in `session.ts`). The device link is printed with a QR code
    (`qr.ts`, `uqr`). Client rule: `isAllowedHost` in `lib/connection.ts`. User page:
    `site/content/docs/phone.md`
  - link forwarding (ADR 0005 §7): `lib/forward.ts` + `components/forward.tsx`, the host rule in
    `src/shared/named-host.ts`; `check:phone` plays a named host by routing `https://nod.example.test`.
    The record may also be this machine's app, exactly `http://127.0.0.1:<port>`
    (`localAppOriginOf`); with nothing remembered the hosted origin (only) offers
    `DEFAULT_LOCAL_APP` (`LocalOffer`, `offer.local`/`assumed`); the app's menu offers "Open links
    from GitHub here" only off port 4518 (`forwardSetupUrl(page, version, servedApp)`)
  - the app (ADR 0008): `ServeOptions.appRoot` serves the build on loopback (`start({ appRoot })`,
    `Started.appLink`; `--web-dir` now without `--allow-host`); `localhost`/`[::1]` page requests
    308 to `127.0.0.1` (`canonicalRedirect`), and only `http://127.0.0.1:<port>` is added to the
    allowed origins; the Host check stays first. `isServedApp(page, pairing)` in `lib/app.ts`
    tells the app from the hosted UI and the dev server
    - service worker: `src/web/sw.ts` (wiring), `lib/sw-rules.ts` (pure: cache `nod-shell-<build>`,
      `strategyFor`, never `/ws`, `/health` or a `token` query), `lib/sw-register.ts` (registered
      only in a prod build off the hosted origin; a page of another build reloads once on the
      worker's `nod-sw-activated`; `checkForUpdate` after a reconnect). The Vite plugin in
      `vite.config.ts` emits `sw.js`, writes the build id and precache list into it and
      `<meta name="nod-build">` into `index.html`
    - "nod serve isn't running": `closedPageOf` (`lib/app.ts`) and `NotRunningPage`
      (`full-page.tsx`); `SERVICE_HINT` names `nod service install` as not released
    - badge: `badgeCount` in `src/shared/attention.ts` (tier 1, open, every repo), `lib/badge.ts`
      (`titleFor`, `applyBadge`, `nod.badge`), `hooks/use-badge.ts` at the root (`app.tsx`);
      install: `hooks/use-install.ts` (`listenForInstall` in `main.tsx`), Settings → App
      (`AppSection` in `settings.tsx`), "Install app" in the avatar menu
    - browser check of it: `bun run build`, `serve --fake --port 452x --token-file <tmp>`, a
      `launchPersistentContext` profile (an incognito context fails installability with
      `in-incognito`); `Page.getInstallabilityErrors` over CDP; stop the server and reload for
      the offline page. Two builds for the takeover: copy `dist/web` twice, swap the build id in
      one copy's `index.html` and `sw.js`, serve each with `--web-dir`
  - the real source without touching `~/.config/nod`: start it from a script calling `start()`
    (`src/server/start.ts`) with `keyFile` and `tokenFile` in a temp folder
  - stale and posting-failure states can't be produced by `--fake`: in a browser check, route
    the socket (`page.routeWebSocket`) and rewrite the `sign` request or its reply
  - the real signer (`src/server/signer/`, ADR 0004): the key file under
    `$XDG_CONFIG_HOME/nod/signing-key.json` (scrypt + AES-256-GCM), our own SSHSIG output, a
    `SigningMethod` seam for ssh-agent signers later; `nod key create|show|test`. Security code: keep
    it small; every SSHSIG test verifies with the real `ssh-keygen`; tests use temp dirs and
    cheap scrypt parameters (`scrypt` option), never the real config dir
  - phone: one breakpoint (below 640 px), the `phone:` variant in `styles.css`, `lib/phone.ts` and
    `useIsPhone()`; rules are added on top, desktop classes stay (`docs/design/design.md`, "Phone").
    `bun run check:phone` (needs a browser, not in `check`) fails on horizontal overflow at 360 px
  - the list on a phone: `pr-row.tsx` lays the same DOM out again with `phone:` rules (the content
    wrapper is `phone:contents`); there is no board (`viewFor`); `check:phone` also taps `STATES`
  - detail page and sign sheet on a phone: `detail-page.tsx`, `batch-dialog.tsx` (`phone:` rules); back closes
    them by a history entry (`hooks/use-back-stop.ts`), the sheet follows `visualViewport`
  - browser checks: `env -u LD_LIBRARY_PATH playwright-cli open --config=<json>` with a config
    whose `launchOptions.executablePath` is the nix-store Chromium
  - browser automation through `nix develop` (playwright libs)
  - conventional commits; PRs are squash-merged and the PR title is the conventional commit
  - releases (semantic-release, as in canvas; on, behind the repository variable
    `RELEASE_ENABLED`, see `docs/release.md`): every merge to `main` publishes
    `@frebreco/nod@next` and deploys the web app to `ui.nod.frebreco.de/next`; `release.yml` by
    hand publishes `latest` and deploys the root (`ui.yml` pushes to the `nod-ui` repo, whose Pages
    serve it). The published CLI opens its own channel's web app (`src/server/web-url.ts`). The
    package is staged by `scripts/build-release.ts`. One-time setup:
    `scripts/bootstrap-release.sh`
  - privacy: the repo is public. No real names of people, tokens, machine names or hostnames in
    the repo or its PRs; fake data uses fictional people and repos

- the site (`site/`): the landing page and the user docs, served at
  `https://nod.frebreco.de/` (the Pages custom domain of this repo). Astro, its own
  package with its own `bun.lock` (`cd site && bun install`), copied from canvas's site; the root
  `bun run check` does not cover it, CI builds it in the `site` job
  - `bun run check`, `bun run build`, `bun run preview` (builds, then serves `dist/` on :4519; the
    only way to try the search); on NixOS inside `nix develop`. Details and pitfalls: `site/README.md`
  - **a user-visible change updates the page in `site/content/docs/` that describes it**, in the
    terms of its Glossary (`glossary.md`; add a term there before using a new one). Commands, flags
    and file names in the docs come from the code (`bun src/cli.ts --help`, `templates/`), and what
    is not released is said to be not released
  - the landing page (`src/pages/index.astro`, `components/landing/Demo.astro`, `styles/landing.css`)
    redraws rows of the dashboard by hand: when `pr-row.tsx`, the tiers or the r3 tokens change,
    change it too. Fictional people and repos only, as everywhere
  - two docs channels, stable at `/` and `main` under `/next` (`scripts/build-channels.sh`);
    `site.yml` deploys them to this repo's Pages after every `release` run and by hand, behind
    its own switch, the repository variable `SITE_ENABLED` (`docs/release.md`)
  - the base path comes from the environment: `SITE_BASE` (`/nod` on the project page, empty at a
    domain root and locally) and `SITE_ORIGIN`, which `site.yml` takes from
    `actions/configure-pages` and `src/lib/channel.ts` reads. Every root-relative link in a
    component goes through `href()`; a hard-coded `/docs/…` or `/favicon.svg` breaks the project
    page. To try it: build with `SITE_BASE=/nod` and serve `dist/` mounted at `/nod`
  - the landing page is one column and few words on purpose: no margin labels, no new sections

- docs: `docs/concept.md` source of truth until an ADR replaces a part; `docs/adr/` decisions; `docs/release.md` how releases work and the owner's setup checklist;
  `docs/enterprise.md` GHE.com and GHES: what works, what it needs, the owner's checklist;
  `docs/findings/` spike and validation evidence; `docs/design/` design system and mockups

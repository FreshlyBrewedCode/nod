nod

- a local-first dashboard that steers a team's attention across agent-written PRs, plus a signed
  human attestation (a "nod") on GitHub so agents can merge on their own
- local: runs on your machine with your `gh` credentials, shared state lives in GitHub; the
  policy and verifier live in the user's own repo (`.nod/`), not in this package
- prototype stage: proving the concept (`docs/concept.md`), not hardening it
- two halves
  1. **`nod serve`** (`src/cli.ts`, `src/server/`): local Bun server, polls GitHub, holds the
     signing key, one token-guarded WebSocket used only by the user's own browser
  2. **web app** (`src/web/`): Vite/React SPA, hosted UI later, Vite dev server locally
- `src/shared/protocol.ts` is the wire contract of both halves; `src/kit/` is the pure helper
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
  - dev: `bun run dev` (Vite on :4517) and `nod serve` (:4518, `bun src/cli.ts serve`)
    - `bun src/cli.ts serve --fake [--scenario team|clear|first-run|fresh|join] [--frozen]`: the
      mockup's team in memory (`src/server/fake-*.ts`); open the printed host link. Fake
      passphrase: anything but `wrong`
    - the pairing token is stable under `$XDG_CONFIG_HOME/nod/serve-token`; pass `--token-file`
      to keep tests and experiments out of it
    - against GitHub: `bun src/cli.ts serve --dir <a clone of the repo> [--poll 60]`;
      `NOD_DEBUG=1` logs each poll's queries and GraphQL cost. Experiments use a throwaway
      `XDG_CONFIG_HOME` (key and token) and then need `GH_CONFIG_DIR` pointing at the real gh
      config, or `gh auth token` finds no login. Finding 03 is the sandbox run
  - server seams: `Source` (`src/server/source.ts`; `fake-source.ts`, and `github-source.ts`
    with its parts in `src/server/github/`: the `GitHubApi` seam with an injectable `fetch`,
    the queries, `map.ts` (GraphQL PR + the verifier's summary → `PrFacts`, never classifies),
    the brief parser, patch-ids in the clone, setup and enrolment; tests run on
    `github/fake-github.ts`), `Signer`
    (`signer.ts`: the seam, the unlock window and the fake), `view.ts` turns a source's `PrFacts` into the user-relative view model;
    `src/shared/attention.ts` is the pure layout logic (tiers, lanes, buckets, board) the UI
    renders; the web app talks only through `useConnection` (`src/web/hooks/`)
  - web app: `app.tsx` gates on the connection (calm full pages) and mounts
    `components/dashboard.tsx` (list state, keyboard, resizable panel); rows in
    `pr-row.tsx`, panel in `detail-panel.tsx`; pure helpers with tests in `src/web/lib/`
    (route, focus, selection, panel width, time, diff bar, wording); theme tokens (the r3
    palette) in `styles.css`; one ticking clock (`hooks/use-clock.ts`). The board
    (`board.tsx`, group by Waiting on or State) opens the same panel as a 540 px overlay
    drawer. Every way to sign calls `openBatch(prNumbers)` (`components/batch-dialog.tsx`):
    review, unlock in place, signed / stale / posting failed, the steps a pure state machine
    in `lib/batch.ts`; the passphrase only ever lives in its input (`components/unlock.tsx`,
    also the lock chip). Screenshots of it: `docs/design/r3/impl/`
  - onboarding (`components/onboarding.tsx`): shown by `app.tsx` while the setup or the key is
    not ready, reopened at `#/setup` (avatar menu); where it starts is derived from server state
    only (`lib/onboarding.ts`, tested). Deep links (`components/link-landing.tsx`,
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
  - the real source without touching `~/.config/nod`: start it from a script calling `start()`
    (`src/server/start.ts`) with `keyFile` and `tokenFile` in a temp folder
  - stale and posting-failure states can't be produced by `--fake`: in a browser check, route
    the socket (`page.routeWebSocket`) and rewrite the `sign` request or its reply
  - the real signer (`src/server/signer/`, ADR 0004): the key file under
    `$XDG_CONFIG_HOME/nod/signing-key.json` (scrypt + AES-256-GCM), our own SSHSIG output, a
    `SigningMethod` seam for ssh-agent signers later; `nod key create|show|test`. Security code: keep
    it small; every SSHSIG test verifies with the real `ssh-keygen`; tests use temp dirs and
    cheap scrypt parameters (`scrypt` option), never the real config dir
  - browser checks: `env -u LD_LIBRARY_PATH playwright-cli open --config=<json>` with a config
    whose `launchOptions.executablePath` is the nix-store Chromium
  - browser automation through `nix develop` (playwright libs)
  - conventional commits; PRs are squash-merged and the PR title is the conventional commit
  - releases (semantic-release, as in canvas; prepared but switched off until
    `RELEASE_ENABLED` is set, see `docs/release.md`): every merge to `main` publishes
    `@frebreco/nod@next` and deploys the web app to `ui.nod.frebreco.de/next`; `release.yml` by
    hand publishes `latest` and deploys the root (`ui.yml` pushes to the `nod-ui` repo, whose Pages
    serve it). The published CLI opens its own channel's web app (`src/server/web-url.ts`). The
    package is staged by `scripts/build-release.ts`. One-time setup:
    `scripts/bootstrap-release.sh`
  - privacy: the repo is public. No real names of people, tokens, machine names or hostnames in
    the repo or its PRs; fake data uses fictional people and repos

- docs: `docs/concept.md` source of truth until an ADR replaces a part; `docs/adr/` decisions; `docs/release.md` how releases work and the owner's setup checklist;
  `docs/enterprise.md` GHE.com and GHES: what works, what it needs, the owner's checklist;
  `docs/findings/` spike and validation evidence; `docs/design/` design system and mockups

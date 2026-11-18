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
  - server seams: `Source` (`src/server/source.ts`; fake now, GitHub later), `Signer`
    (`signer.ts`), `view.ts` turns a source's `PrFacts` into the user-relative view model;
    `src/shared/attention.ts` is the pure layout logic (tiers, lanes, buckets, board) the UI
    renders; the web app talks only through `useConnection` (`src/web/hooks/`)
  - browser checks: `env -u LD_LIBRARY_PATH playwright-cli open --config=<json>` with a config
    whose `launchOptions.executablePath` is the nix-store Chromium
  - browser automation through `nix develop` (playwright libs)
  - conventional commits; PRs are squash-merged and the PR title is the conventional commit
  - privacy: the repo is public. No real names of people, tokens, machine names or hostnames in
    the repo or its PRs; fake data uses fictional people and repos

- docs: `docs/concept.md` source of truth until an ADR replaces a part; `docs/adr/` decisions;
  `docs/findings/` spike and validation evidence; `docs/design/` design system and mockups

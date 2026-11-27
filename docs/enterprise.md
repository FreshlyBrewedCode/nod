# nod on GitHub Enterprise

nod runs against three kinds of GitHub host:

- **github.com**, where it was built and proven (findings 01–03);
- **GitHub Enterprise Cloud with data residency**, `<name>.ghe.com`: the target of this work;
- **GitHub Enterprise Server** (GHES), any other host: by construction, cheaply, untested.

## The rule

A repo of the list (`$XDG_CONFIG_HOME/nod/config.json`, `nod repo add`, ADR 0007) carries its
host: `{ "host": "acme.ghe.com", "repo": "finance/ledger" }`, typed as
`acme.ghe.com/finance/ledger` or a URL on that host. For a clone (`--dir`, or an empty list and
`nod serve` started in a clone) the host comes from the clone's `origin` remote, once.
Everything derives from the host. `src/kit/host.ts` is the only place that knows the endpoint
shapes:

| host             | REST                         | GraphQL                              | web                      |
| ---------------- | ---------------------------- | ------------------------------------ | ------------------------ |
| `github.com`     | `https://api.github.com`     | `https://api.github.com/graphql`     | `https://github.com`     |
| `<name>.ghe.com` | `https://api.<name>.ghe.com` | `https://api.<name>.ghe.com/graphql` | `https://<name>.ghe.com` |
| any other (GHES) | `https://<host>/api/v3`      | `https://<host>/api/graphql`         | `https://<host>`         |

- `nod serve` and `nod init` read the host from `origin` in any spelling git takes
  (`git@host:owner/repo.git`, `ssh://user@host:port/owner/repo`, `https://host[:port]/owner/repo`).
  `--host` overrides it. An ssh alias from `~/.ssh/config` (`git@work:acme/widgets`) cannot be
  resolved: both refuse it and ask for `--host`.
- The token is `gh auth token --hostname <host>`, one per host. It is sent to that host's API
  only: every request goes through the kit's `fetchWithToken`, which refuses any other URL and
  follows redirects by hand, within the API only. Patch-id fetches go to `origin` as it is; over
  https the token rides in an `http.<web URL>/.extraheader` (`tokenGitEnv`, through
  `GIT_CONFIG_*`), so git sends it to that host and nowhere else.
- Hosts side by side: the list may mix github.com, GHE.com and GHES. Each host has its own
  `GitHubApi`, login and rate limit, and one `Poll` query per poll for all of its repos (up to ten
  per query, `REPOS_PER_QUERY`). A host without a `gh` login shows its sign-in command on its
  repos; the others read. A login can differ per host (`mona` and `mona_acme`); each row is
  relative to its host's login.
- nod's own clones (`$XDG_CACHE_HOME/nod/clones/<host>/<owner>/<repo>.git`, blobless and bare)
  are cloned from `https://<host web>/<owner>/<repo>.git` with the same scoped extra header, which
  also covers the blobs a diff or the setup PR's checkout fetch on demand. It is never written into
  the clone's config.
- Every `gh` call of `nod init` runs with `GH_HOST=<host>`, `gh api` calls carry
  `--hostname <host>`, and `--repo` takes `<host>/<owner>/<repo>` off github.com.
- The verifier (`.nod/verify.ts`) uses `GITHUB_API_URL` and `GITHUB_SERVER_URL`, which Actions
  sets on every host.
- The web app gets the host's web URL in `welcome.github`. Deep links off github.com name the host:
  `#/pr/<host>/<owner>/<repo>/<n>`; a link without a host is a github.com link.

## What it needs

- `gh auth login --hostname <name>.ghe.com` (or your GHES host) on the machine running `nod serve`
  and `nod init`. `nod serve` says so when it is missing. Note: a `GH_TOKEN` in the environment
  wins over the stored login for github.com and `*.ghe.com` alike (that is `gh`'s rule).
- Rulesets and GitHub Actions enabled on that host, for the repo.
- `nod init --ruleset` looks up the host's GitHub Actions app (`GET /apps/github-actions`) and pins
  the `nod` check to it. On github.com its id is 15368; on any other host a failed lookup stops
  `nod init` before anything changes, rather than pinning a wrong id.
- The verifier's runner must reach:
  - the kit pin in `.nod/package.json`: a git pin (`github:FreshlyBrewedCode/nod#<sha>`) comes from
    github.com, a version range from the npm registry (or your mirror). Without that access, point
    `nod init --kit` at a copy the runners can reach;
  - the two pinned actions, `actions/checkout` and `oven-sh/setup-bun`, which live on github.com.
    GHE.com falls back to github.com for actions it does not have itself. GHES needs GitHub Connect
    with access to github.com actions, or copies synced to the server.
- Logins of Enterprise Managed Users (every account on GHE.com) look like `mona_acme`: the kit
  accepts `<handle>_<shortcode>` (shortcode 3 to 8 letters or digits, 39 characters in all).

## What is unverified

Nothing here has run against a real GHE.com or GHES host: the development machine is only logged
in to github.com. Confirmed by reading GitHub's docs: the endpoint shapes above, the managed-user
login shape, `gh auth token --hostname`, `GH_HOST`, and that GHE.com resolves actions from
github.com when the enterprise has no copy. Confirmed by tests: everything else, on the fake GitHub
playing `acme.ghe.com` and `git.example.test` (it answers only that host's URL shapes).

Open for a real run: that `/apps/github-actions` answers on GHE.com with the id the ruleset needs;
that rulesets, auto-merge and `pull_request_target` behave as on github.com (finding 01); that
`gh` stores a GHES host with a port the way `--hostname` asks for it.

## Checklist for the owner: one real GHE.com repo

Use a throwaway repo, e.g. `acme/nod-trial` on `acme.ghe.com` (replace both with yours). Keep the
nod config out of `~/.config/nod` with a scratch `XDG_CONFIG_HOME` if you like (then also set
`GH_CONFIG_DIR` to your real `gh` config).

1. **Log `gh` in to the host.** `gh auth login --hostname acme.ghe.com`, then
   `gh auth status --hostname acme.ghe.com`. Expect: logged in as your managed user
   (`you_acme`), with `repo` and `workflow` scopes.
2. **Clone.** `gh repo clone acme.ghe.com/acme/nod-trial && cd nod-trial`, then
   `git remote get-url origin`. Expect: `https://acme.ghe.com/acme/nod-trial.git` (or the ssh
   form `acme@acme.ghe.com:acme/nod-trial.git`; an ssh alias needs `--host acme.ghe.com` below).
3. **Open one PR to look at.** Push a branch with a small change and `gh pr create --fill`.
   Expect: a PR URL on `https://acme.ghe.com/acme/nod-trial/pull/1`.
4. **`nod serve` shows it.** `NOD_DEBUG=1 nod serve` (from a checkout: `bun src/cli.ts serve --dir .`).
   Expect: `nod serve on ws://127.0.0.1:4518 · GitHub on acme.ghe.com · acme/nod-trial`, poll lines
   without errors, and after pairing the dashboard lists the PR; its GitHub links open
   `acme.ghe.com`.
   Then the list, beside a github.com repo: `nod repo add acme.ghe.com/acme/nod-trial` and
   `nod repo add <a github.com repo of yours>`, and `NOD_DEBUG=1 nod serve` outside any clone.
   Expect: `nod repo add` clones into `~/.cache/nod/clones/acme.ghe.com/acme/nod-trial.git`, one
   poll line per host (`nod serve: poll acme.ghe.com: 1 GraphQL …`), both repos' PRs in one
   dashboard with a repo chip each. Where the GHE.com login differs from the github.com one, a
   nod's payload must name the GHE.com login as `reviewer` (ADR 0007, 8; `RepoInfo.login`):
   check it in the batch dialog's details and in the posted comment.
5. **Open the setup PR.** In onboarding, create the key and press "Open setup PR", or run
   `nod init --signer-key <your key>.pub`. Expect: a PR "chore: set up nod …" whose body tells
   you to run `nod init --ruleset --repo acme/nod-trial --host acme.ghe.com` and says where the
   runner fetches the kit pin from. No `nod` check runs on it: the verifier is not on the default
   branch yet.
6. **Merge it** under the repo's current rules (`gh pr merge --squash`). Expect: `.nod/` and
   `.github/workflows/nod.yml` on the default branch; the verifier runs on the next PR event. If
   the run fails at "install the kit", the runner cannot reach github.com or npm (see above).
7. **Require nod.** `nod init --ruleset`. Expect: `created the ruleset "nod" … (app <id>)` with
   the id `gh api --hostname acme.ghe.com apps/github-actions --jq .id` prints, and
   `auto-merge is enabled.` If it says it could not look up the Actions app, nothing was changed:
   note the error.
8. **Enrol a key** (only if another person joins): they run steps 1, 2 and 4 and press "Open
   enrolment PR". Expect: a PR adding one line `they_acme namespaces="nod" ssh-ed25519 …` to
   `.nod/allowed_signers`; it needs a peer nod (yours) to merge.
9. **Sign one PR.** Push a new commit to the PR from step 3 (so the verifier runs), open it in
   the dashboard, nod it. Expect: a nod comment on the PR on `acme.ghe.com`, then a green `nod`
   check within a minute; the sticky comment's "Open in nod" link reads
   `…/#/pr/acme.ghe.com/acme/nod-trial/<n>`.
10. **Auto-merge.** `gh pr merge --auto --squash <n>`. Expect: it merges on its own once `nod` is
    green. Then report what differed from these expectations in a finding.

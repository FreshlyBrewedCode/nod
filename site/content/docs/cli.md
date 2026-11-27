---
title: CLI
description: Every command and flag of nod.
section: Reference
order: 1
---

```
nod <command>

  serve        start the local server for the dashboard
  init         set up .nod/ and the workflow in this repository
  key          create, show or test the signing key

  --help       show the help
  --version    show the version
```

The package `@frebreco/nod` is on npm: `bunx @frebreco/nod <command>` runs the stable release,
`bunx @frebreco/nod@next <command>` the pre-release of `main`. From a checkout of the nod
repository, `nod` is `bun src/cli.ts`; see [Quick start](/docs/quick-start). The CLI needs Bun 1.4.1 or newer.

## `nod serve`

Starts the local server the dashboard pairs with, and prints the link to open. Run it in a clone
of the repository.

| Flag | Meaning |
| --- | --- |
| `--port <n>` | Port on `127.0.0.1`. Default 4518 |
| `--dir <path>` | A clone of the repository. Default: this folder. nod fetches pull request objects into it (`refs/nod/*`) to compute patch-ids, and never checks anything out |
| `--repo <owner/name>` | The repository. Default: the clone's `origin` |
| `--host <host>` | Its GitHub host: `github.com`, `<name>.ghe.com` or a GitHub Enterprise Server. Default: the host of the clone's `origin`. Needed when `origin` names an ssh alias |
| `--poll <seconds>` | How often to read GitHub. Default 60, from 10 to 3600 |
| `--web-url <url>` | The web app to pair with. Default: this release's, or the Vite dev server for a checkout. Also the environment variable `NOD_WEB_URL`. Not released: only the hosted web app and a page on this machine (such as the dev server) can pair with `127.0.0.1` |
| `--fake` | Serve a fictional team and repository instead of GitHub |
| `--scenario <name>` | With `--fake`: `team` (the default), `clear`, `first-run`, `fresh`, `join`, `inbox`, `shared` or `repos`; see [Fake scenarios](#fake-scenarios) |
| `--frozen` | With `--fake`: nothing changes on its own |
| `--token-file <path>` | Where the pairing token is kept. Default `$XDG_CONFIG_HOME/nod/serve-token`. The remote token is next to it, as `<path>-remote` |
| `--new-token` | Replace both tokens: every paired browser pairs again |
| `--new-remote-token` | Replace only the remote token: the other device pairs again, this machine's browser stays paired |
| `--allow-host <name[:port]>` | Not released. Also answer to this https name, the [named host](/docs/phone) a TLS proxy such as `tailscale serve` gives the port, and serve the dashboard there for another device. Prints the device link and its QR code |
| `--web-dir <path>` | With `--allow-host`: the built dashboard to serve. Default: the one this nod ships; in a checkout `dist/web`, from `bun run build` |
| `--open` | Open the link in a browser |
| `--no-open` | Do not. The default |

`--dir`, `--host` and `--poll` read GitHub and cannot be combined with `--fake`. `--allow-host`
works with and without it. There is no config file: give `--allow-host` every time.

`NOD_DEBUG=1` logs each poll's queries and their GraphQL cost.

### Fake scenarios

`--fake --scenario <name>` starts the fictional team in one of these states. Where a first open
lands and which [offer](/docs/dashboard#offers) shows are not released: the released version opens
onboarding first wherever the setup or the key is not ready.

| Scenario | The repository and you | A first open lands on | The offer |
| --- | --- | --- | --- |
| `team` | Enforced, your key active, everyone busy | the dashboard | none |
| `clear` | As `team`, with everything that needed you done an hour ago | the dashboard, "Nothing needs you" | none |
| `first-run` | The setup PR open with your key in it, no pull request classified yet | the dashboard, with the legend | **Setup PR #494 is open** |
| `fresh` | No repository picked, no key | the repository picker, then the dashboard | **Share one policy with the team** |
| `join` | Enforced, you joining without a key; a teammate approved one pull request on GitHub | the dashboard | **Sign your own agent PRs** |
| `inbox` | The inbox step: no `.nod/`, no key, the pull requests classified locally. Not released | the dashboard | **Share one policy with the team** |
| `shared` | The shared policy, its check not required yet; your key active, you an admin. Not released | the dashboard | **Let agents merge on their own** |
| `repos` | [Three repositories](/docs/dashboard#many-repositories): `tallyho/fieldbook` enforced, `tallyho/field-app` at the inbox step, `finance/ledger` on the fictional host `acme.ghe.com` with the shared policy; your key active in the first and the last. Not released | the dashboard, with a repo chip on every row | **Share one policy with the team**, for `tallyho/field-app` |

## `nod init`

Writes the repository's setup, commits it on the branch `nod/setup` and opens the setup PR with
`gh`. With `--ruleset` it instead makes `nod` the gate of the default branch.

| Flag | Meaning |
| --- | --- |
| `--signer "<login> <key>"` | A first signer: GitHub login and `ssh-ed25519` public key. Repeatable. Optional: without one `.nod/allowed_signers` starts empty (not released) |
| `--signer-key <file>` | A public key file; the login is your `gh` user's |
| `--repo <owner/name>` | The repository. Default: the one of `--dir` |
| `--host <host>` | Its GitHub host, e.g. `acme.ghe.com`. Default: the host of `--dir`'s `origin`, else `github.com`. `gh` must be logged in there |
| `--dir <path>` | The local clone. Default: this folder |
| `--kit <spec>` | The kit dependency for `.nod/package.json`. Default: this nod's version, or `github:FreshlyBrewedCode/nod#<commit>` for a checkout |
| `--dry-run` | Write the files here, change nothing else, and print the PR description |
| `--no-pr` | Commit on `nod/setup`; do not push or open the PR |
| `--force` | Replace an existing `.nod/`. With `--ruleset`: apply it before the verifier is on the default branch |
| `--ruleset` | After the setup PR merged: require `nod` on the default branch and enable auto-merge. Re-runs the verifier on open pull requests whose `nod` check is still neutral (not released). Needs admin rights |

Without `--signer` or `--signer-key` the setup PR has nobody in `.nod/allowed_signers` (not
released; the released version refuses): approvals count, and what needs a signed nod waits until
someone enrols. `nod init --ruleset` warns when nobody is enrolled on the default branch, as a
required check then means nobody can change `.nod/` any more. The clone must have no uncommitted
changes.

```sh
nod init
nod init --signer "$(nod key show)"
nod init --ruleset
```

## `nod key`

The signing key from a terminal. The passphrase is read without echo and never printed.

| Command | Does |
| --- | --- |
| `nod key create` | Create the signing key. Asks for a passphrase |
| `nod key create --replace` | Replace an existing key. The old file is kept aside |
| `nod key show` | Print the line for `.nod/allowed_signers` |
| `nod key show --login <login>` | The GitHub login the line names. Default: the `gh` login |
| `nod key test` | Unlock the key, sign a test message, verify it with `ssh-keygen` |

`--key-file <path>` works with all three: the key file, by default
`$XDG_CONFIG_HOME/nod/signing-key.json`.

## Files and environment

| Path or variable | What |
| --- | --- |
| `$XDG_CONFIG_HOME/nod/signing-key.json` | The encrypted signing key. `~/.config/nod/` when the variable is unset |
| `$XDG_CONFIG_HOME/nod/serve-token` | The pairing token of `nod serve` |
| `$XDG_CONFIG_HOME/nod/serve-token-remote` | The remote token, the named host's (`--allow-host`) |
| `NOD_WEB_URL` | The web app to pair with, as `--web-url` |
| `NOD_DEBUG=1` | Log each poll |
| `gh auth token` | Where the GitHub token comes from. `gh` keeps its login under `$XDG_CONFIG_HOME/gh`, so a changed `XDG_CONFIG_HOME` also needs `GH_CONFIG_DIR` |

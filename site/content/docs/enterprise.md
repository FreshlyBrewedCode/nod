---
title: GitHub Enterprise
description: Running nod against GHE.com and GitHub Enterprise Server, and what that needs.
section: Reference
order: 2
---

nod runs against three kinds of GitHub host:

- **github.com**, where it was built and tried;
- **GitHub Enterprise Cloud with data residency**, `<name>.ghe.com`;
- **GitHub Enterprise Server**, any other host.

> **Not run against a real Enterprise host yet.** The endpoint shapes are confirmed from GitHub's
> documentation and everything else by tests against a fake host. Expect rough edges on a first
> real run.

## How the host is found

The host comes from the clone's `origin` remote, once, and everything derives from it.

| Host | REST | GraphQL | Web |
| --- | --- | --- | --- |
| `github.com` | `https://api.github.com` | `https://api.github.com/graphql` | `https://github.com` |
| `<name>.ghe.com` | `https://api.<name>.ghe.com` | `https://api.<name>.ghe.com/graphql` | `https://<name>.ghe.com` |
| any other | `https://<host>/api/v3` | `https://<host>/api/graphql` | `https://<host>` |

`nod serve` and `nod init` read `origin` in any spelling git takes. `--host` overrides it. An ssh
alias from your ssh config (`git@work:acme/widgets`) cannot be resolved: both refuse it and ask
for `--host`.

Your token is `gh auth token --hostname <host>`, and it is sent to that host's API only.

## What it needs

- `gh auth login --hostname acme.ghe.com` (or your server) on the machine that runs `nod serve`
  and `nod init`. A `GH_TOKEN` in the environment wins over the stored login; that is `gh`'s
  rule.
- Rulesets and GitHub Actions enabled on the host, for the repository.
- The verifier's runner must reach:
  - **the kit pin** in `.nod/package.json`. A git pin (`github:FreshlyBrewedCode/nod#<commit>`)
    comes from github.com, a version range from the npm registry or your mirror. Without that
    access, point `nod init --kit` at a copy the runners can reach.
  - **the two pinned actions**, `actions/checkout` and `oven-sh/setup-bun`, which live on
    github.com. GHE.com falls back to github.com for actions it does not have. GitHub Enterprise
    Server needs GitHub Connect with access to github.com actions, or copies synced to the
    server.
- `nod init --ruleset` looks up the host's GitHub Actions app and pins the `nod` check to it. If
  the lookup fails, it stops before anything changes rather than pinning a wrong id.

Logins of Enterprise Managed Users, which is every account on GHE.com, look like `mona_acme`.
nod accepts that shape wherever it takes a login.

## Deep links

Off github.com a [deep link](/docs/nodding#deep-links) names the host first:

```
https://ui.nod.frebreco.de/#/pr/acme.ghe.com/acme/widgets/12
https://ui.nod.frebreco.de/#/batch/acme.ghe.com/acme/widgets/12,14
```

A link without a host is a github.com link. The dashboard compares the link's host and
repository with the ones it serves, and says so when they differ.

## A first real run

Use a throwaway repository, e.g. `acme/nod-trial` on `acme.ghe.com`.

1. `gh auth login --hostname acme.ghe.com`, then `gh auth status --hostname acme.ghe.com`.
2. `gh repo clone acme.ghe.com/acme/nod-trial`.
3. Open a small pull request to look at.
4. `NOD_DEBUG=1 nod serve` in the clone. Expect
   `nod serve on ws://127.0.0.1:4518 · GitHub on acme.ghe.com · acme/nod-trial` and the pull
   request in the dashboard.
5. On the setup page (**Setup** in the avatar menu), create the key and open the setup PR. Its
   description names the command for step 7 with `--host`.
6. Merge it under the repository's current rules.
7. `nod init --ruleset`. Expect "created the ruleset" with the app id that
   `gh api --hostname acme.ghe.com apps/github-actions --jq .id` prints.
8. Push a commit to the pull request, nod it, arm auto-merge. Expect a green `nod` check within
   a minute and a merge.

If the verifier's run fails at "install the kit", the runner cannot reach github.com or npm.

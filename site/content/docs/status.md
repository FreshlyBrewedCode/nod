---
title: Status
description: What works today, what is not released, and what is not built.
section: Start
order: 3
---

nod is a prototype. It is proving a concept: that a small team can let agents merge on their own
when attention is steered well and a human's nod is cheap to give and hard to fake by accident.

## What works

Tried end to end on a public sandbox repository on github.com:

- the setup PR, the ruleset, and merging under the old rules first;
- the policy: paths, diff size, dependencies, a custom classifier, declared risk and FYI;
- self and peer nods, a batch nod over several pull requests, a nod surviving a clean rebase and
  dropping on a content change;
- the dashboard against real pull requests: the list by attention and by time, the board, the
  detail panel, the batch dialog, FYI acks, onboarding, enrolling a teammate's key;
- comment to green check in 12 to 20 seconds, then auto-merge within seconds.

## Released

- **The npm package.** `@frebreco/nod` is published: a stable release on `latest`, and a
  pre-release on `next` for every merge to `main` that changes what nod does (a feature or a fix).
- **The hosted web app.** `ui.nod.frebreco.de` serves the web app of the stable release, and
  `ui.nod.frebreco.de/next` the one of `main`, deployed with each pre-release. Deep links in sticky
  comments point at the stable one.

[Quick start](/docs/quick-start) still shows the from-source way, which also has what is not
released.

## Not released

**Not released** on these pages means: on `main`, not in a stable release yet. Such a part is in
`@frebreco/nod@next` and on `ui.nod.frebreco.de/next` once it is merged, and reaches `latest` and
the root of `ui.nod.frebreco.de` with the next stable release.

Built and not released yet, among others:

- **The inbox.** A repository with no `.nod/` gets a sorted dashboard: your `nod serve`
  classifies the pull requests itself, and Needs you holds the reviews asked of you or your team
  and your own stuck pull requests. Not tried on a real repository yet.
  [Dashboard](/docs/dashboard#the-inbox)
- **Approving without a key.** With no key that signs in the repository, the batch dialog posts
  GitHub approvals instead of nods, at the inbox step and where the policy lets approvals count.
  Tried on a fake GitHub only. [Approve or nod](/docs/nodding#approve-or-nod)

## Not built

- **An owned GitHub App for the check** ("app mode"). Until then the check can be forged by a
  workflow on any branch. [Security and limits](/docs/security#the-forgeable-check)
- **Touch ID and 1Password signers.** Signing methods that confirm each signature through an SSH
  agent. Today there is the passphrase only.
- **An agent CLI or MCP server**: "what does my pull request need", "ask a teammate", "is it
  nodded".
- **An epics view.** Grouping by epic, built on GitHub issues and sub-issues. Rows carry
  "needs first" and "unblocks" hints today.
- **Several repositories.** One repository per `nod serve`.
- **Adopting an existing SSH key.** nod makes its own.
- **A light scheme** for the web app.
- **nod on a phone, all the way.** A phone reaches `nod serve` through a named host
  ([On your phone](/docs/phone)), but the dashboard has no phone layout yet, does not reconnect
  on purpose when the phone wakes, and a deep link from a GitHub notification does not open on
  the phone.

## Limits by design

- Sized for one repository, two or three people, about 50 to 100 merged pull requests in two
  weeks. nod polls GitHub; it has no webhooks.
- Rulesets on private repositories need GitHub Pro, Team or Enterprise.
- A repository with one human has no peer: see
  [One-human repositories](/docs/keys#one-human-repositories).
- GitHub Enterprise hosts are supported by construction and untested on a real host.
  [GitHub Enterprise](/docs/enterprise)

## Following along

The work is tracked in the open on
[GitHub](https://github.com/FreshlyBrewedCode/nod/issues).

---
title: Agents
description: What a coding agent sees of nod, what it writes in a pull request, and what it must not do.
section: Using nod
order: 3
---

nod needs nothing installed on the agent's side. An agent works with pull requests as it always
does; what changes is the last step. It does not wait for an approval. It arms auto-merge, and
the pull request merges once the `nod` check and the other required checks are green.

## What an agent sees

- **The check `nod`** on the pull request, red or green, with a title such as "waiting for a peer
  approval or nod", "nodded by mara-l (self)" or "no nod needed". While the repository does not
  require it yet, a check that waits is grey (neutral) instead of red (not released).
- **One sticky comment** by the verifier, once the check is required: the category, the risk,
  what is still needed and from whom, and why. It is updated in place. See
  [the verifier](/docs/verifier#the-sticky-comment).
- **Labels** `nod:auto`, `nod:decide`, `nod:fyi` and `nod:risk-0` to `nod:risk-3`. They are for
  display; nothing reads them to decide.

An agent can read all three with `gh pr view` and `gh pr checks`.

## The brief

The **brief** is the pull request description, written so a human can decide quickly. nod reads
these parts, as headings (`## What`), bold labels (`**What**`) or plain labels (`What: …`):

```md
## What
Adds day-based proration when a tenant switches plan mid-cycle.

## Why
Support fixes these invoices by hand, about 12 a week.

## Risk
Money math. Rounding happens per invoice line.

## Verified
41 new unit tests; replayed 300 real plan changes from staging.

## Look at
modules/billing/proration.ts

Risk: medium
Epic: #431
Depends on #485
```

The dashboard shows the first line of **What** on a prominent row and the whole brief in the
detail panel. Four lines mean something to the policy's `declared()` classifier:

| Line | Effect |
| --- | --- |
| `Risk: none`, `low`, `medium` or `high` | Sets a risk floor. It can raise the risk, never lower it |
| `FYI` or `FYI: …` (also a title starting with `FYI`) | Marks the pull request as an [FYI](/docs/nodding#fyi) |
| `Epic: #12` | Names the epic; shown in the detail panel |
| `Depends on #7` | Rows show "needs #7 first" and "unblocks #…" |

The description is written by the author, so nothing in it can lower a requirement.

## Merging

```sh
gh pr merge --auto --squash <number>
```

Auto-merge waits for the required checks and then merges. With nod, a pull request that needs no
nod merges as soon as CI is green; one that needs a nod merges seconds after the nod.

A stacked pull request, one whose base is another branch, cannot be armed until it targets the
default branch. After the lower one merges and GitHub retargets it, arm it then. A nod made for
the old base no longer counts.

## What an agent must not do

- **Merge around the check.** `gh pr merge --admin`, or changing the ruleset, defeats nod.
- **Add or change workflow files** unless that is the task. Any change under
  `.github/workflows/` or `.nod/` needs a peer nod, and a workflow on any branch could forge the
  check. See [Security and limits](/docs/security).
- **Sign.** An agent has no signing key and must not ask for the passphrase.

Put the first two into the agent's instructions, and give agents a token that cannot do them:
[recommended agent settings](/docs/security#recommended-agent-settings).

## Not built yet

A command line or MCP server for agents ("what does my pull request need", "ask a teammate", "is
it nodded") is planned and does not exist. Today an agent reads the check and the sticky comment.

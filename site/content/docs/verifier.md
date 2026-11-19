---
title: Verifier
description: The workflow that runs on every pull request, the check it sets, its summary and its sticky comment.
section: Your repository
order: 2
---

The **verifier** is `.nod/verify.ts` in your repository, run by `.github/workflows/nod.yml`. It
is the one thing that decides whether a pull request may merge. `nod serve` and the dashboard only
read what it wrote; they never run the policy themselves.

## The workflow

```yaml
# .github/workflows/nod.yml, shortened
on:
  pull_request_target:
    types: [opened, synchronize, reopened, edited] # edited: a base change needs a new verdict
  issue_comment:
    types: [created, edited, deleted] # nods arrive as comments

permissions: {}

jobs:
  verify:
    if: github.event_name == 'pull_request_target' || github.event.issue.pull_request
    runs-on: ubuntu-latest
    permissions:
      checks: write # the `nod` check run on the PR head
      contents: read # fetch the base and the PR's commits as data
      pull-requests: write # read the PR; write its sticky comment and nod:* labels
      issues: read # PR comments live on the issue
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          ref: ${{ github.event.repository.default_branch }} # the default branch only, never PR code
          fetch-depth: 0
          persist-credentials: false
      - uses: oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6 # v2.2.0
        with:
          bun-version: "1.4.2"
      - name: install the kit (pinned by .nod/bun.lock)
        working-directory: .nod
        run: bun install --frozen-lockfile --ignore-scripts
      - name: verify
        working-directory: .nod
        run: bun verify.ts
        env:
          GITHUB_TOKEN: ${{ github.token }}
```

What matters in it:

- It runs on every pull request event and every pull request comment, always **from the default
  branch**. The policy, the allowed signers and the verifier's code are the default branch's.
- It never checks out, installs or runs code from the pull request. The pull request's commits
  are fetched as git objects and only diffed.
- The job is named `verify`, not `nod`: a job named `nod` would itself be a green check called
  `nod`.
- Third-party actions are pinned by commit, and `${{ }}` only ever expands numbers and fixed
  strings.

GitHub announced that from 2026-12-02 a default rule may block `pull_request_target` workflows in
public repositories unless they are allowed. If the `verify` job stops running on new pull
requests, allow `.github/workflows/nod.yml` under **Settings → Actions → General**.

## One run

1. Read the event: which pull request.
2. Fetch the pull request's base tip and head commit as git objects.
3. Compute the changed files and the patch-id with `git`.
4. Classify with [`.nod/policy.ts`](/docs/policy): findings, risk, category, requirement.
5. Verify every `nod` block in the pull request's comments with `ssh-keygen -Y verify`, against
   `.nod/allowed_signers`.
6. Evaluate which nods [count](/docs/nodding#when-a-nod-counts) and whether the requirement is
   met.
7. Create the check run `nod` on the head commit.
8. Update the sticky comment and the labels.

The cryptography is OpenSSH's and the diff is git's. The kit, `@frebreco/nod/kit`, provides the
helpers the file calls; the flow itself is in your repository.

## The check

The check run is named `nod` and concludes only `success` or `failure`. Its title says where the
pull request stands:

```
no nod needed
waiting for a self nod
waiting for a peer nod (have: mara-l (self))
nodded by mara-l (self), jonas-r (peer)
```

A ruleset on the default branch requires this check, from the GitHub Actions app, with zero
required approvals. `nod init --ruleset` creates that ruleset and turns auto-merge on.

**The verifier fails closed.** If it crashes, or the policy file is broken, the result is a red
`nod` check with the error in it, never a green one.

From comment to green check takes about 12 to 20 seconds on GitHub's runners.

## The summary

Each check run carries a machine-readable **summary** in its output: what the verifier found,
which nods it saw, and what is missing. This is what `nod serve` reads to build the dashboard.

```json
{ "v": 1, "repo": "tallyho/fieldbook", "pr": 31, "author": "mara-l", "base": "main",
  "head_sha": "130866aa…", "patch_id": "cb7eb360…",
  "category": "decide", "risk": 3, "fyi": false,
  "requirement": { "level": "peer", "named": [] },
  "reasons": [
    { "classifier": "diffSize", "tag": "size:xl", "risk": 3, "detail": "+1103 −0 in 1 file" },
    { "classifier": "declared", "tag": "declared:risk", "risk": 2, "detail": "the brief declares risk medium" } ],
  "nods": [
    { "reviewer": "mara-l", "role": "self", "counts": true, "matched": "head_sha", "why_not": null,
      "verdict": "approve", "level": "review", "signed_at": "2026-11-18T20:26:13.014Z" } ],
  "satisfied": false, "missing": [ { "kind": "peer" } ],
  "signers": [ "mara-l", "jonas-r", "inescal" ], "errors": [] }
```

## The sticky comment

One comment per pull request, updated in place. It says the same in words, for people and
agents:

```md
**nod** · decide · risk high · waiting for a peer nod (have: mara-l (self))

- Needs a peer nod from `jonas-r` or `inescal`

Nodded: `mara-l` (self, head_sha)

<details><summary>Why: 2 reasons</summary>

- `size:xl` · high · +1103 −0 in 1 file
- `declared:risk` · medium · the brief declares risk medium

</details>

[Open in nod](https://ui.nod.frebreco.de/#/pr/tallyho/fieldbook/31) to look and nod. A link never approves by itself.
```

The verifier also sets the labels `nod:auto`, `nod:decide` or `nod:fyi`, and `nod:risk-0` to
`nod:risk-3`. The comment and the labels are display only. A failure to write them never changes
the verdict, and nothing reads them to decide.

## Other required checks

nod's ruleset requires only `nod`. Keep your CI requirement in a ruleset of its own; rulesets
layer, so `nod init --ruleset` never has to touch it. If classic branch protection still requires
approvals on the branch, lower that to 0, or auto-merge keeps waiting for an approval as well.

## Who creates the check

In v1 the check is created with the workflow's own token, so it comes from the GitHub Actions
app. That has a limit you should know: see [Security and limits](/docs/security#the-forgeable-check).
The verifier takes the check token from one place (`NOD_CHECK_TOKEN`, else `GITHUB_TOKEN`), which
is the seam for a stricter mode later.

---
title: Glossary
description: The terms these docs use, and what each one means.
section: Reference
order: 4
---

| Term | Meaning |
| --- | --- |
| **ask** | What the dashboard asks of you on a pull request: Self-attest, Sign as peer, Sign as owner or Re-attest. [Nodding](/docs/nodding#the-ask) |
| **attention tier** | One of four sizes a pull request is shown in: prominent, normal, one line, folded. [Dashboard](/docs/dashboard#attention-tiers) |
| **batch** | One or more pull requests nodded with one signature. [Nodding](/docs/nodding#the-batch-dialog) |
| **batch dialog** | The dialog every way to sign opens: review, unlock, signed |
| **board** | The dashboard's view in columns, by who a pull request waits on or by state. [Dashboard](/docs/dashboard#board) |
| **brief** | The pull request description an agent writes: what, why, risk, verified, look at. [Agents](/docs/agents#the-brief) |
| **category** | Where the policy puts a pull request: `auto`, `decide` or `fyi`. [Policy](/docs/policy#requirements) |
| **check** | The check run named `nod` on a pull request's head commit. A ruleset requires it. [Verifier](/docs/verifier#the-check) |
| **classifier** | A function in the policy that looks at a pull request and reports findings. [Policy](/docs/policy#built-in-classifiers) |
| **cluster** | Folded pull requests shown as one row, "7 low-risk changes", that expands in place |
| **dashboard** | The web app, paired with `nod serve`. [Dashboard](/docs/dashboard) |
| **deep link** | A link that opens a pull request or a batch in the dashboard. It never approves by itself. [Nodding](/docs/nodding#deep-links) |
| **detail panel** | The side panel (list) or drawer (board) showing one pull request |
| **enrolment** | Getting a public key into `.nod/allowed_signers`, through a pull request. [Signing keys](/docs/keys#enrolment) |
| **finding** | One fact a classifier reports: a tag, a sentence, optionally a risk |
| **FYI** | A pull request people should notice without anyone having to nod. [Nodding](/docs/nodding#fyi) |
| **FYI ack** | "Got it" on an FYI: an unsigned 👀 reaction |
| **host link** | The link `nod serve` prints. It pairs the web app with the server |
| **kit** | `@frebreco/nod/kit`: the helpers the policy and the verifier import. [Architecture](/docs/architecture#the-kit) |
| **lane** | A section of the list by attention: Needs you, Worth knowing, Background |
| **named nod** | A nod by a person the policy names |
| **nod** | A signed statement by a human approving a pull request, posted as a comment. Also the name of the tool and of the check |
| **`nod serve`** | The local server on your machine. [CLI](/docs/cli#nod-serve) |
| **patch-id** | A hash of a pull request's diff against its base. It survives a clean rebase. [Nodding](/docs/nodding#when-a-nod-counts) |
| **payload** | The one line of JSON a nod signs |
| **peer nod** | A nod by a signer other than the pull request's author |
| **policy** | `.nod/policy.ts`: classifiers and rules that decide what a pull request needs. [Policy](/docs/policy) |
| **prompter** | The human who prompted the agent. On GitHub, the pull request's author |
| **requirement** | What a pull request needs before it may merge: none, a self nod, a peer nod, a named nod. [Policy](/docs/policy#requirements) |
| **risk** | 0 to 3: none, low, medium, high. The highest risk of any finding |
| **rule** | A function in the policy that turns findings into a requirement or an FYI |
| **self nod** | A nod by the pull request's author: the prompter attesting their own agent's work |
| **setup PR** | The pull request `nod init` opens to add `.nod/` and the workflow. [Quick start](/docs/quick-start) |
| **signer** | A person whose public key is in `.nod/allowed_signers` |
| **signing key** | Your ed25519 key, encrypted on your machine. [Signing keys](/docs/keys#the-key-file) |
| **stale** | A nod whose pull request changed after it was made. It no longer counts |
| **sticky comment** | The verifier's one comment on a pull request, updated in place. [Verifier](/docs/verifier#the-sticky-comment) |
| **stuck** | A check is failing, or the pull request has waited on a person for 12 hours or more |
| **summary** | The machine-readable result in the check run's output, read by `nod serve`. [Verifier](/docs/verifier#the-summary) |
| **trust root** | `.nod/allowed_signers` on the default branch |
| **unlock** | Decrypting the signing key into the memory of `nod serve`, for 15 minutes or one signature |
| **verifier** | `.nod/verify.ts`, run by the workflow on every pull request event. It sets the check. [Verifier](/docs/verifier) |

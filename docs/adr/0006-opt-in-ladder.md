# 0006: The opt-in ladder

Status: accepted (2026-11-26) by the owner in the second brainstorm ([concept](../concept.md), "Opening up", part A). Amends [ADR 0001](0001-nod-format-and-validity.md) rule 9 (the verifier's conclusions), the concept's "The repo's required-approvals count is lowered to 0" (approvals now count toward the policy) and the server's rule that `map.ts` never classifies. Epic #38.

## Context

Adopting nod asked for everything at once: the dashboard showed nothing useful until the repo had `.nod/`, the workflow and an enrolled key, and once the `nod` check was required, everyone in the repo had to use nod, because only a signed nod could turn it green. A teammate who never installs nod lost the one thing they know, the GitHub approval. And between the setup PR and `nod init --ruleset`, the check was already red on every PR that wanted a nod, although it blocked nothing.

nod should be useful to one person on day one with nothing in the repo, and every further step should be opt-in.

## Decision

1. **The ladder.** Four steps, each one opted into by whoever it concerns:

   | Step | Who opts in | What the repo sees | What you get |
   |---|---|---|---|
   | **0. Inbox** | you alone | nothing (👀 acks are reactions, as before) | the attention dashboard |
   | **1. Shared policy** | the repo, setup PR | `.nod/`, a check that never blocks | one classification for everyone; the verifier becomes the source |
   | **2. Signing** | each person | nod comments from those who enrolled | attest your own agent PRs |
   | **3. Enforced** | the repo, `nod init --ruleset` | a required `nod` check, 0 required approvals | agents merge on their own |

   The docs call the steps **inbox**, **shared policy**, **signing** and **enforced**.

2. **GitHub approvals count toward the policy, by default.** A requirement is a set of slots (ADR 0001 rule 7 and `src/kit/requirement.ts`): the level (`self` or `peer`) and one per named person.
   - A **`peer`** slot is filled by a peer nod or by a counting approval; a **named** slot by that person's nod or approval; a **`self`** slot by any nod or any counting approval.
   - An approval **counts** when it is the person's latest review that approves, requests changes or was dismissed (comments do not change it), its state is `APPROVED`, its `commit_id` is the PR's head now, the reviewer is not the PR author and not a bot (`user.type` `Bot`), and the reviewer has write access to the repo (`GET /repos/{o}/{r}/collaborators/{login}/permission` says `admin` or `write`; `maintain` reads as `write`). On a public repo anyone can press "Approve"; GitHub does not count those either. A permission lookup that fails makes that approval not count, with the reason in the summary.
   - A dismissed approval does not count; neither does one given before the last push. Unlike a nod there is no patch-id equivalence: GitHub records only the commit, and comparing patch-ids would mean fetching and diffing that commit for every review. A clean rebase therefore keeps a nod but needs a new approval.
   - **Nods only.** `peer({ approvals: false })`, `self({ approvals: false })` and `named("alice", { approvals: false })` make that slot a nod-only slot. `peer`, `self` and `named("alice")` stay plain requirements, so every existing policy keeps working and now accepts approvals. Combining keeps the strictest of both parts: `strictest(peer, self({ approvals: false }))` needs a peer's approval or nod, and some nod.
   - **The verifier runs on reviews.** The workflow adds `pull_request_review` (`submitted`, `dismissed`), so an approval counts at once. That event has no `_target` variant: it runs the workflow file as the PR has it. The job therefore skips PRs from forks (their token is read-only and could not set the check; their approvals count on the PR's next event), and still runs `.nod/verify.ts` from the default branch. A branch of this repo that changes the workflow could run its own version on a review, but such a branch can already run any workflow on `push`: that is ADR 0003's known limit, not a new one.
   - The kit's own protections require **nods only**: a change under `PROTECTED_PATHS` (`.nod/**`, `.github/workflows/**`), and a classifier or rule that throws. Changing the trust root, the policy or the verifier still needs a signature from a key the agents don't have.
   - **The trade-off, in plain words.** An agent holding my `gh` token can approve a teammate's PR as me. That is exactly what it can do on GitHub without nod, and it stays within what Actions mode promises (ADR 0003): nod guards against mistakes and unattended merges, not against an agent that sets out to misuse a human's token. A rule that must not rest on a token, because it guards something an agent should never wave through, says `approvals: false`; the kit's protections do.

3. **The check is `neutral` until it is enforced** (amends ADR 0001 rule 9 and finding 01's "conclude only success or failure"). The `nod` check concludes `success` when the requirement is met. When it is not met, it concludes `failure` if the check is enforced and `neutral` if not, so nobody sees a red ✗ on a check that blocks nothing; the title says what is missing either way. A verifier error or a crash is always `failure`. The sticky comment is only created while enforced; one that exists already is kept up to date, so it never goes stale.

4. **How the verifier knows it is enforced.** `neutral` passes a required check, so the verifier must never conclude `neutral` where the check is required. On every run it asks GitHub about the PR's **base branch**, with the workflow's own token:
   - `GET /repos/{o}/{r}/rules/branches/{branch}`: an active `required_status_checks` rule naming the context `nod` (from any ruleset, the repo's or the organization's) means enforced. `nod init --ruleset` creates exactly that, so it stays the one switch.
   - `GET /repos/{o}/{r}/branches/{branch}`: classic branch protection whose required status checks name `nod` means enforced.
   - Neither: not enforced.
   - **Any doubt counts as enforced.** A lookup that fails, or a protected branch whose required checks the token cannot see, makes the run conclude as if enforced, with the reason in the summary. A spurious red ✗ is a nuisance; a `neutral` check on a branch that requires it would let a PR merge without its nod. (The issue suggested falling back to "not enforced" on error; that is the direction that opens the gate, so we fall back the other way.)
   - **`definePolicy({ enforced: true })`** skips the lookup and always concludes `success` or `failure`, for a repo that wants the red ✗ without a ruleset, or whose host cannot answer the lookup. There is no `enforced: false`: it could only ever be wrong in the unsafe direction.
   - **Switching it on.** A PR whose `nod` check concluded `neutral` before the ruleset existed would pass the new required check until the verifier runs again. `nod init --ruleset` therefore re-runs the verifier workflow for every open PR into the default branch whose latest `nod` check is `neutral`, and names the ones it could not re-run (a push or any comment re-runs it).

5. **The summary says it.** The check summary (`CheckSummary` v1; fields only get added) carries `approvals` (every approval found and whether it counts), `filled` (each filled slot, who filled it and whether by a `nod` or an `approval`), `missing` (each entry says whether an approval would fill it) and `enforcement` (`enforced`, and what says so: `ruleset`, `branch_protection`, `policy`, or `unknown` when it was assumed). A summary from an older verifier reads as: no approvals, every slot nod-only, enforced.

6. **Step 0 classifies locally** (amends "`map.ts` never classifies"). With no verifier summary on a PR, `nod serve` runs the kit's built-in classifiers on what GraphQL returns: display only, no repo code runs, and a verifier summary always wins. Built in #40.

7. **Onboarding stops gating.** Once `gh` is logged in and a repo is picked, the dashboard shows; setup, key and enforcement become offers. A teammate joining a set-up repo needs no key unless they want to sign. Built in #42.

## Consequences

- A repo that merged the setup PR but never ran `nod init --ruleset` shows a grey `nod` check and no sticky comment; nothing about how its people merge changes.
- A repo where nobody signs works on approvals alone, except for changes to nod's own setup, which need a peer's nod.
- The ruleset's 0 required approvals stays: the approvals that matter are now counted by the policy, per PR, instead of by GitHub, for every PR alike.
- Every verifier run makes two more reads (the branch rules and the branch) and one per approver (the permission). All are readable with the workflow token's default `metadata: read`.
- Not verified here: a real approval counting, the permission lookup with the workflow token, and the neutral check on a real PR. The owner checks them in the sandbox.

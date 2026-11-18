# `nod serve` against a real repo

> Tasks #6 and #7 (epic #1), run on 2026-11-18 against the public sandbox `FreshlyBrewedCode/nod-sandbox` (the setup of [finding 02](02-repo-owned-setup.md)).
> `nod serve --dir <a fresh clone> --port 4519`, with a throwaway `XDG_CONFIG_HOME` for the key and the pairing token, driven by a small socket client. Everything ran as the one logged-in `gh` user (principal `FreshlyBrewedCode`, the fictional alice). bob is a fictional signer with a throwaway key; the agents in the briefs are fictional.

## Verdict

| # | What | Verdict |
|---|---|---|
| 1 | The snapshot shows the open PRs with sensible tiers | **Holds.** All 10 open PRs classified from the verifier's summary; tiers, asks and "waiting on" as the r3 rules say (table below). Patch-ids computed in the clone equal the verifier's. |
| 2 | Create a key, see it pending, enrol it through a PR a peer nods | **Holds.** `create-key` → `not-enrolled`; `open-enrol-pr` opened [#36](https://github.com/FreshlyBrewedCode/nod-sandbox/pull/36) (one line, commit by the clone's identity) → `pending` on #36; bob's nod → green → auto-merged 15 s later → the key turned `active` in the next snapshot, pushed as `signer`. |
| 3 | Sign a batch of PRs that need my self nod; checks turn green; auto-merge merges | **Holds.** One signature over #22 (re-attest of a stale nod), #27 and #33; the same comment on all three; all green 12–13 s after the comments, merged 2–11 s after that. |
| 4 | Ack an FYI | **Holds.** `ack-fyi` on #28 put a 👀 reaction by the user on it; the snapshot showed "You got it" at once and the poll read it back from the reactions (acked: me; pending: bob, carol). The reaction was removed again afterwards. |
| 5 | Remove the test key, refill the sandbox | **Done.** [#37](https://github.com/FreshlyBrewedCode/nod-sandbox/pull/37) removed the line (bob nodded, auto-merged); the key showed `not-enrolled` again. Three fresh PRs: #38, #39, #40. |

## The snapshot, step 1

As the snapshot showed it with the test key enrolled (before step 3). "Tier" is `attention.ts`'s rule on the view model; the requirement's slots in brackets.

| # | title | category | risk | requirement | needsMe / ask | tier | waiting on |
|---|---|---|---|---|---|---|---|
| #22 | feat(app): log slow requests | decide | 1 | Prompter self-attest [prompter: stale] | yes: Re-attest | 2 | me |
| #26 | fix(core): retry failing jobs twice | decide | 3 | Another human [peer: missing] | no | 3 | anyone but me |
| #27 | feat(app): log a request id for every request | decide | 1 | Prompter self-attest [prompter: missing] | yes: Self-attest | 2 | me |
| #28 | docs: write down what on-call should know | fyi | 0 | None (auto-merge) | no | 4 | merge |
| #29 | feat(copy): friendlier empty state | auto | 0 | None (auto-merge) | no | 4 | checks (`qa` environment) |
| #30 | test(app): every widget costs at least ten euros | decide | 1 | Prompter self-attest [prompter: ok] | no | 3 (mine, stuck: test fails) | the agent |
| #31 | feat(app): a synonym table for search | decide | 3 | Another human [peer: missing] | no | 3 (mine, high risk) | anyone but me |
| #32 | docs(architecture): note that jobs are not retried | auto | 0 | None (auto-merge) | no | 4 | merge |
| #33 | feat(search): parse quoted phrases | decide | 2 | Prompter self-attest [prompter: missing] | yes: Self-attest | 2 | me |
| #34 | feat(search): rank exact phrase matches first | decide | 2 | Prompter self-attest [prompter: missing] | yes: Self-attest | 2 | me (needs #33 first) |

Every PR here is the user's own (the agents use the user's token), so nothing is tier 1, and #28's FYI asks nothing of its author. With the key not enrolled (before step 2 and after step 5) the same rows have no ask at all: readable, nothing signable (ADR 0002).

## Latencies

| From → to | Time |
|---|---|
| `sign` request → reply (3 fresh patch-ids, 3 comments) | 4.8 s |
| comment → `nod` check green on GitHub | 12–13 s |
| `sign` request → green in the snapshot | 21 s (#22, #27, #33 together) |
| green → merged by auto-merge | 2–11 s |
| `sign` request → merged in the snapshot | 21–35 s |
| bob's nod on #36 (posted outside nod serve) → merged in the snapshot | 17 s (the fast polling of `open-enrol-pr` was still on) |
| first poll after start (10 open, 25 merged or closed in 14 days) | 4.7 s |

A nod posted by nod serve shows on the row at once as "being verified" (from the comment, before the verifier ran), then as counting.

## API cost

- **Idle poll: one GraphQL query, cost 3, about 1.2 s, ~45 KB**, for 10 open PRs with checks, 60 comments, 👀 reactions, timeline and files each. Every 60 s that is 180 points an hour of the 5000.
- **A poll with news: two queries, cost 4.** The second asks only for what is new: the `text` of `nod` check runs not seen yet (GraphQL's `CheckRun.text` holds the summary, so no REST call is needed), merged PRs not cached yet, epic titles, `.nod/allowed_signers` at an enrolment PR's head.
- **The first poll: 4 queries, cost 6** (25 merged PRs in the window, fetched 20 at a time, then their check run texts).
- **REST:** the default branch's rules once every 10 minutes (setup checks); comments, reactions and the enrolment PR only when the user acts.
- Fast polling after an action (every 5 s for 2 minutes) costs about 75 points.

## Surprising

- **`gh` keeps its login under `$XDG_CONFIG_HOME/gh`.** With a throwaway `XDG_CONFIG_HOME`, `gh auth token` fails and nod serve sees no account. The run pointed `GH_CONFIG_DIR` at the real gh config (read only). nod serve now says "`gh` is not logged in" in the terminal and the snapshot instead of failing quietly.
- **The budget is shared.** `remaining` jumped between polls (4891, 4784, 4887 …): every process using the same `gh` login draws from it. nod serve stops polling below 10× a poll's cost (at least 50 points) until the reset, and shows that as `sync.rateLimit`, not as an error.
- **A stacked PR is briefly unclassified after its lower PR merges.** GitHub retargets #34 to `main`; its summary still says base `agent/search-phrases`, so nod serve treats it as outdated ("not classified", high risk, no slot) for the ~12 s until the verifier's `edited` run. Honest, if a little jumpy.
- **Rebase auto-merges still name the merging account** as the committer of the rebased commits, as finding 02 found. The sandbox's merges in this run did too; the commits' authors stay the spike identity.
- **The enrolment PR's commit** goes through the contents API with the clone's `user.name`/`user.email` as author and committer, so it carries the same identity a `git commit` in that clone would, not the account's profile.
- **`pending` needs a PR.** A new key is `not-enrolled` until an open PR adds it to `allowed_signers` (the enrolment or the setup PR); then `pending` with that PR. Both sign nothing.

## The sandbox, left for the playtest

- **`main`** at `24bdd96`. Signers: `FreshlyBrewedCode` (alice's throwaway key, the one from finding 02), `bob`, `carol`. The test key of this run is gone (#37).
- **Open PRs** (10), each with a What / Why / Risk / Verified / Look at brief:

| PR | What it shows |
|---|---|
| #26 | needs a peer: `core/` retry |
| #28 | FYI-declared docs page |
| #29 | auto, waiting on checks (`needs-qa`) |
| #30 | a failing check (nodded) |
| #31 | large, has a self nod, needs a peer |
| #32 | docs only, auto |
| #34 | needs a self nod; lower half of a stack since #33 merged and it was retargeted to `main` |
| [#38](https://github.com/FreshlyBrewedCode/nod-sandbox/pull/38) | new: needs a self nod, small `app/` change, auto-merge armed |
| [#39](https://github.com/FreshlyBrewedCode/nod-sandbox/pull/39) | new: upper half of the stack on #34 (`Depends on #34`, base `agent/search-rank-phrases`) |
| [#40](https://github.com/FreshlyBrewedCode/nod-sandbox/pull/40) | new: a stale nod, alice's self nod on the first commit, the second changed the content; auto-merge armed |

Merged in this run: #22, #27, #33 (the batch), #36 and #37 (the test key's enrolment and removal).

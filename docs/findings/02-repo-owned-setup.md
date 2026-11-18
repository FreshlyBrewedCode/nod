# The repo-owned setup, end to end

> Task #5 (epic #1), run on 2026-11-18 against the public sandbox `FreshlyBrewedCode/nod-sandbox`.
> Everything ran as the one logged-in `gh` user (principal `FreshlyBrewedCode`, the fictional alice, so her nods are **self** nods). bob and carol are fictional signers with throwaway keys. The agents named in the PR briefs are fictional too.
> The setup is what `nod init` writes from [`templates/`](../../templates/); the kit is pinned to `github:FreshlyBrewedCode/nod#5a6fb49` through `.nod/bun.lock`.

## Verdict

| # | What | Verdict |
|---|---|---|
| 1 | `nod init` opens the setup PR; it merges under the old rule; `nod init --ruleset` makes `nod` the gate | **Holds.** Setup PR [#14](https://github.com/FreshlyBrewedCode/nod-sandbox/pull/14), merged without a ruleset; `--ruleset` then updated the ruleset `nod` to active. |
| a | Path classifier: a `.nod/` change needs a peer | **Holds.** [#15](https://github.com/FreshlyBrewedCode/nod-sandbox/pull/15) (enrol carol): red with alice's self nod, green with bob's, auto-merged 3 s later. |
| b | Diff size raises the requirement | **Holds.** 4 added lines need a self nod ([#17](https://github.com/FreshlyBrewedCode/nod-sandbox/pull/17)); 1202 lines (`size:xl`) need a peer ([#18](https://github.com/FreshlyBrewedCode/nod-sandbox/pull/18)). |
| c | The custom module-tier classifier | **Holds.** A tier-3-only change merges with no nod ([#19](https://github.com/FreshlyBrewedCode/nod-sandbox/pull/19)); a tier-1 change needs a peer ([#20](https://github.com/FreshlyBrewedCode/nod-sandbox/pull/20)). |
| d | `none`: an auto PR turns green with no nod and auto-merges | **Holds.** Docs only ([#21](https://github.com/FreshlyBrewedCode/nod-sandbox/pull/21)), merged 9 s after the check. |
| e | Self vs peer | **Holds.** Self suffices for #17; for #15, #18 and #20 the self nod is listed ("have: FreshlyBrewedCode (self)") and does not count as a peer; bob alone satisfies a peer requirement ([#35](https://github.com/FreshlyBrewedCode/nod-sandbox/pull/35)). |
| f | One batch nod over 3 PRs | **Holds.** One signature over [#23](https://github.com/FreshlyBrewedCode/nod-sandbox/pull/23), [#24](https://github.com/FreshlyBrewedCode/nod-sandbox/pull/24), [#25](https://github.com/FreshlyBrewedCode/nod-sandbox/pull/25); all three green within 13 s of each other and auto-merged. |
| g | A clean rebase keeps a nod, a content change drops it | **Holds.** [#22](https://github.com/FreshlyBrewedCode/nod-sandbox/pull/22): rebased onto a main that had moved by 6 commits, still green (`matched: patch_id`); one more commit, red (`stale`). Left open, by design. |
| – | The check summary decodes from the check run through the API; sticky comment; labels | **Holds**, after one fix to the workflow's permissions (see "Found on the way"). |
| – | A crash ends red, never green | **Holds in the tests** (`src/init/templates.test.ts` runs `.nod/verify.ts` against a fake API with an unfetchable head). Not induced on GitHub. |

Comment to check took 14–21 s, as in spike 1. Auto-merge then merged within 2–3 s of a green check. All 39 verifier runs after the setup merged finished without an error. The job is green either way; the verdict is in the `nod` check. The job's steps: checkout 1 s, setup-bun 2 s, `bun install --frozen-lockfile` under 1 s, `verify.ts` 2 s.

## Setup

1. **Removing the spike verifier.** The ruleset `nod` (from spike 1, proof point 2) was set to `disabled` for one direct push to `main`. That push removed `.nod/` and the spike's `nod.yml`, and added a small fictional service:
   - `modules/{billing,search,icons,copy}/module.json` with tiers 1, 2, 3, 3;
   - `core/scheduler.ts`, `app/server.ts`, `docs/`;
   - a `package.json` and `bun.lock`;
   - `tests/*.sh`, run by an ordinary `ci.yml` whose job is `test`.
2. **`nod init`** in the sandbox clone:
   ```
   $ nod init --dir <clone> --signer "FreshlyBrewedCode ssh-ed25519 AAAA…" --signer "bob ssh-ed25519 AAAA…" \
              --kit github:FreshlyBrewedCode/nod#5a6fb495d7936dbe15069979607003fab4dc71e5
   installing the kit in .nod/ (writes .nod/bun.lock)…
   committed the setup on nod/setup
   opened the setup PR: https://github.com/FreshlyBrewedCode/nod-sandbox/pull/14
   It merges under this repository's current rules. After the merge, a repo admin runs:
     nod init --ruleset --repo FreshlyBrewedCode/nod-sandbox
   ```
   The PR adds 8 files: `.github/workflows/nod.yml`, `.nod/{.gitignore,allowed_signers,bun.lock,classifiers/module-tier.ts,package.json,policy.ts,verify.ts}`. The workflow did not run on #14 itself, because `pull_request_target` runs the default branch's workflow and `main` had none.
3. **Merged #14** under the old rule (no ruleset).
4. **`nod init --ruleset`**:
   ```
   updated the ruleset "nod" on FreshlyBrewedCode/nod-sandbox: main needs a PR with 0 approvals and a green nod check from GitHub Actions (app 15368); nobody can bypass it.
   auto-merge is enabled.
   ```
5. **A second ruleset `ci`** requires `test` from GitHub Actions. I added it by hand, the way a team keeps its CI requirement next to nod's. Rulesets layer, so `nod init --ruleset` never has to touch other required checks.

Without `--kit`, a checkout of nod pins the kit to its own commit, e.g. `github:FreshlyBrewedCode/nod#dc1c56e…` (checked with `--dry-run`). A release pins `^<version>`.

**The kit as a git dependency works today.** `bun install` of `github:FreshlyBrewedCode/nod#<sha>` resolves the `./kit` export. The lockfile pins the commit (`FreshlyBrewedCode-nod-5a6fb49`) and an integrity hash, and `--frozen-lockfile` installs it on the runner. The cost: a git install brings the root package's runtime dependencies along (React, Tailwind, Lucide…), about 75 MB and 14 packages. That took 1.6 s locally and under 1 s on the runner. The npm package (`scripts/build-release.ts`) carries only what the kit and CLI need.

## The scenarios

The signer was a test script: the kit's `fetchPullRequestObjects`, `patchId`, `serializePayload`, `nodHumanLine` and `renderNodComment`, then `ssh-keygen -Y sign -n nod` with a throwaway key, and `gh pr comment` with the same body on each PR. Every PR was armed with `gh pr merge --auto --rebase` unless noted.

| PR | Change | Before | After the nods | End |
|---|---|---|---|---|
| #15 | `.nod/allowed_signers` + carol | `waiting for a peer nod` (tags `protected`, `nod-setup`) | alice: `waiting for a peer nod (have: FreshlyBrewedCode (self))`; bob: `nodded by FreshlyBrewedCode (self), bob (peer)` | auto-merged |
| #16 | `.github/workflows/nod.yml` permissions | `waiting for a peer nod` (`ci-config`) | alice + bob: green | auto-merged |
| #17 | +4 lines in `app/` | `waiting for a self nod` (`size:s`) | alice: `nodded by FreshlyBrewedCode (self)` | auto-merged |
| #18 | +1202 lines in `app/` | `waiting for a peer nod` (`size:xl`, risk 3) | alice: still waiting; bob: green | auto-merged |
| #19 | `modules/icons/` only (tier 3) | `no nod needed` (`tier-3`, `pure-module`), category `auto` | – | auto-merged, no nod |
| #20 | `modules/billing/` (tier 1) | `waiting for a peer nod` (`tier-1`, risk 3) | alice: still waiting; bob (batch with #18): green | auto-merged |
| #21 | `docs/guide.md` | `no nod needed`, category `auto` | – | auto-merged, no nod |
| #23, #24, #25 | tier-2 search, a dependency bump (`deps-only`), an app line | each `waiting for a self nod` | **one** batch nod by alice over all three: each `nodded by FreshlyBrewedCode (self)` | all auto-merged |
| #22 | +4 lines in `app/` | `waiting for a self nod` | alice: green (`head_sha`) → rebased onto the new main: green (`patch_id`) → new commit: `waiting for a self nod`, nod `stale` | open |
| #35 | `.nod/policy.ts` | `waiting for a peer nod` | bob alone: `nodded by bob (peer)` | auto-merged |

The batch payload (#23–#25), as signed:

```json
{"v":1,"repo":"FreshlyBrewedCode/nod-sandbox","entries":[
  {"pr":23,"base":"main","head_sha":"a4721b32…","patch_id":"cf5aacba…"},
  {"pr":24,"base":"main","head_sha":"65f724ef…","patch_id":"00d2b0ca…"},
  {"pr":25,"base":"main","head_sha":"d1ce5532…","patch_id":"c818f78f…"}],
 "verdict":"approve","level":"review","reviewer":"FreshlyBrewedCode","signed_at":"2026-11-18T20:22:33…Z"}
```

### A sticky comment (#31, as the verifier left it)

```
<!-- nod:sticky -->
**nod** · decide · risk high · waiting for a peer nod \(have: FreshlyBrewedCode \(self\)\)

- Needs a peer nod from `bob` or `carol`

Nodded: `FreshlyBrewedCode` (self, head_sha)

<details><summary>Why: 2 reasons</summary>

- `size:xl` · high · \+1103 −0 in 1 file
- `declared:risk` · medium · the brief declares risk medium

</details>

[Open in nod](https://ui.nod.frebreco.de/#/pr/FreshlyBrewedCode/nod-sandbox/31) to look and nod. A link never approves by itself.
```

The labels on it are `nod:decide` and `nod:risk-3`. The verifier creates the `nod:*` labels with colours the first time it uses them.

### A decoded summary (check run [135108448102](https://github.com/FreshlyBrewedCode/nod-sandbox/runs/135108448102) on #31)

`decodeSummary(GET /repos/…/check-runs/135108448102 → output.text)`, trimmed:

```json
{ "v": 1, "repo": "FreshlyBrewedCode/nod-sandbox", "pr": 31, "author": "FreshlyBrewedCode", "base": "main",
  "head_sha": "130866aae73108b41bd1aefb0ff4db86e9d38000", "patch_id": "cb7eb360cb320d1ffe74dba82cefef2835e0b423",
  "category": "decide", "risk": 3, "fyi": false, "requirement": { "level": "peer", "named": [] },
  "reasons": [ { "classifier": "diffSize", "tag": "size:xl", "risk": 3, "detail": "+1103 −0 in 1 file" },
               { "classifier": "declared", "tag": "declared:risk", "risk": 2, "detail": "the brief declares risk medium" } ],
  "nods": [ { "reviewer": "FreshlyBrewedCode", "role": "self", "counts": true, "matched": "head_sha", "why_not": null,
              "verdict": "approve", "level": "review", "signed_at": "2026-11-18T20:26:13.014Z" } ],
  "satisfied": false, "missing": [ { "kind": "peer" } ], "signers": [ "FreshlyBrewedCode", "bob", "carol" ],
  "errors": [], "generated_at": "2026-11-18T20:26:26.736Z" }
```

## Found on the way

- **PR comments need `pull-requests: write`.**
  - With `issues: write` (finding 01's suggestion), the first runs set the check but logged `403 Resource not accessible by integration` on the sticky comment.
  - The template now has `pull-requests: write` and `issues: read`, which also covers creating and setting labels.
  - The fix reached the sandbox as [#16](https://github.com/FreshlyBrewedCode/nod-sandbox/pull/16). It changed `.github/workflows/`, so it needed a peer nod like any other change to the setup.
- **`docs/**` and `**/*.md` both matched files under `docs/`**, so the sticky comment listed `docs` twice. The template now uses `docs/**` plus `*.md` at the root, which reached the sandbox as #35 with a peer nod.
- **`details_url` is ignored** on check runs created with the Actions token. GitHub sets it to the run's own page, so the deep link lives in the sticky comment only. (An app-mode check could carry it.)
- **Auto-merge cannot be armed on a stacked PR** whose base is not the protected branch: `Pull request Protected branch rules not configured for this branch`. The verifier still checks it (#34 has its own `nod`). Once the lower PR merges and GitHub retargets the upper one to `main`, the `edited` event re-runs the verifier. The nod then needs to be for base `main` (ADR 0001, rule 5).
- **Merges done on GitHub carry the merging account's profile name and commit email.** For squash and merge commits it is the author; for rebase merges, the committer. Auto-merge has no way around this, so the sandbox now uses rebase merges, which keep the commit's own author. During proof point 2 (finding 01), two squash merges had put the account's name and email on `main`. I rewrote those two commits to the spike identity while the ruleset was lifted. The account setting "keep my email private" would make GitHub use the noreply address; it was not touched.
- **`environment: ''`** (from an expression that evaluates to nothing) runs the job without an environment. The sandbox's `ci.yml` uses that to hold PRs labelled `needs-qa` in a `qa` environment with a required reviewer.

## The sandbox, left for the dashboard playtest

- **`main`** is at `46aeaf6`. It has the `nod init` setup with the two fixes above, three enrolled signers (`FreshlyBrewedCode`, `bob`, `carol`), and the fictional service.
- **Rulesets:** `nod` (id 27578833: a PR with 0 approvals, `nod` from GitHub Actions, no bypass) and `ci` (id 27580801: `test` from GitHub Actions). Auto-merge is on.
- **Environment `qa`:** a required reviewer (the owner). PRs labelled `needs-qa` wait there.
- **Open PRs**, each with a What / Why / Risk / Verified / Look at brief by a fictional agent:

| PR | What it shows | `nod` | Other checks | Auto-merge |
|---|---|---|---|---|
| [#26](https://github.com/FreshlyBrewedCode/nod-sandbox/pull/26) | needs a peer: `core/` retry | waiting for a peer nod | test ✓ | armed |
| [#27](https://github.com/FreshlyBrewedCode/nod-sandbox/pull/27) | needs a self nod: small app change | waiting for a self nod | test ✓ | armed |
| [#28](https://github.com/FreshlyBrewedCode/nod-sandbox/pull/28) | FYI-declared docs page | no nod needed (FYI), category `fyi` | test ✓ | not armed |
| [#29](https://github.com/FreshlyBrewedCode/nod-sandbox/pull/29) | auto, waiting on checks: tier-3 copy, `needs-qa` | no nod needed | test **waiting** (qa) | armed |
| [#30](https://github.com/FreshlyBrewedCode/nod-sandbox/pull/30) | one failing check: a new test fails on the seed data | nodded by FreshlyBrewedCode (self) | test **✗** | armed |
| [#22](https://github.com/FreshlyBrewedCode/nod-sandbox/pull/22) | stale nod, content changed after the nod | waiting for a self nod (nod `stale`) | test ✓ | armed |
| [#31](https://github.com/FreshlyBrewedCode/nod-sandbox/pull/31) | large: 1103-line synonym table | waiting for a peer nod (have: self) | test ✓ | armed |
| [#32](https://github.com/FreshlyBrewedCode/nod-sandbox/pull/32) | docs only | no nod needed, category `auto` | test ✓ | not armed |
| [#33](https://github.com/FreshlyBrewedCode/nod-sandbox/pull/33) | stack, lower: parse quoted phrases (tier 2) | waiting for a self nod | test ✓ | armed |
| [#34](https://github.com/FreshlyBrewedCode/nod-sandbox/pull/34) | stack, upper: base `agent/search-phrases`, `Depends on #33` | waiting for a self nod (tag `depends-on`) | test ✓ | cannot be armed (see above) |

#28 and #32 are green and not armed, so they stay open for the playtest; armed, they would have merged at once.

## Open questions

1. **Stacked PRs and auto-merge.** Should the dashboard tell the user that an upper PR can only be armed once it targets `main`? Or should the agent arm it after the retarget?
2. **The kit's install size from git** (75 MB of web dependencies). It is harmless on the runner, but moving the web app's dependencies to `devDependencies` in the root `package.json` would make a git install as lean as the npm package.
3. **Merge identity.** Recommend "keep my email private" to people who let agents auto-merge in public repos? The commits are theirs either way.

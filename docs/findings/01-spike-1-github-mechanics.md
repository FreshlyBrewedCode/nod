# Spike 1: do the GitHub-side mechanics hold?

> Spike for #3 (epic #1), run on 2026-11-18 against the private throwaway repo `FreshlyBrewedCode/nod-sandbox` on GitHub Free.
> The scripts and sandbox files are in [`spikes/01-github-mechanics/`](../../spikes/01-github-mechanics/). They are evidence, not production code.
> Everything ran as the one logged-in `gh` user. Its token has the scopes `gist, project, read:org, repo` and no `workflow` scope.
> alice and bob are fictional signers with throwaway ed25519 keys.

## Verdict

| # | Proof point | Verdict |
|---|---|---|
| 1 | Comment → verifier → check on the head SHA | **Holds.** Comment to green check took 12–17 s. |
| 2 | A ruleset enforces the check; auto-merge merges | **Not tested: the plan refused it.** Private repos on Free get `403 Upgrade to GitHub Pro or make this repository public`. The script for it is ready. |
| 3 | Patch-id survives a clean rebase and changes with content | **Holds, with caveats.** If the base edits a line within 3 lines of the change, the patch-id changes and a new nod is needed. The diff must be computed locally with pinned flags; the API diff won't do. |
| 4 | One batch signature turns 3 PRs green | **Holds.** |
| 5 | Self vs peer from the signature alone | **Holds.** The principal is the GitHub login. |
| A | Can an agent without the key make `nod` green? | **Yes, the design as written is forgeable.** A workflow pushed on any branch can create a `nod` check from the GitHub Actions app. GitHub cannot tell it from the real one. Recommended fix: the check comes from a self-owned GitHub App with no backend, whose key only default-branch jobs can read. See [Attacks](#attacks). |

Two more holes turned up and are fixed in the spike verifier. Both are tested:
- **Retargeting a PR kept its nod.** A nod matched by `head_sha` alone survived a base change, which can pull unreviewed content into `main`. Entries now carry `base`.
- **The files API stops at 3000 files.** A padded PR hid a `core/` change from the policy. The file list now comes from git.

## 1. Comment → verifier → check on the head SHA

The workflow `nod.yml` runs on `pull_request_target` (`opened, synchronize, reopened, edited`) and on `issue_comment` (`created, edited, deleted`):
1. It checks out the default branch only, with `persist-credentials: false`.
2. It fetches the base tip and the PR head SHA as git objects. Nothing from the PR is checked out or executed.
3. It verifies every ```` ```nod ```` block in every PR comment with `ssh-keygen -Y verify -f .nod/allowed_signers -I <reviewer> -n nod`.
4. It `POST`s a check run named `nod` to `/repos/{repo}/check-runs` with `head_sha` set to the PR head.

First run, PR #1 opened, no nod (run https://github.com/FreshlyBrewedCode/nod-sandbox/actions/runs/44371665738):

```
check run 135039889467 failure on 6ed02f04…: waiting for a self nod
```

After alice's signed comment ([#1 comment](https://github.com/FreshlyBrewedCode/nod-sandbox/pull/1#issuecomment-6988084093), run 44372564909):

```
posted on #1 … at 18:42:08.3Z
{"merge_state":"CLEAN","rollup":{"state":"SUCCESS", contexts: verify SUCCESS, nod SUCCESS},
 "nod_runs":[{"id":135043127984,"conclusion":"success","suite":120113554987,"completed_at":"18:42:23Z",
              "title":"nodded by FreshlyBrewedCode (self, head_sha)"},
             {"id":135039889467,"conclusion":"failure","suite":120113554987,"completed_at":"18:37:15Z"}]}
```

What we observed:
- **`pull_request_target` runs now belong to the PR head.**
  - The run's `head_sha` is the PR head (`6ed02f0`), and the job's own check run `verify` shows up on the PR head, in the same check suite.
  - This contradicts the concept's note that these jobs "report on the base commit".
  - It still holds that the verdict needs its own check run, because the job succeeds even when the verdict is red.
  - **Never name the job `nod`.** Its job check would be a green `nod` whenever the script exits 0.
  - `issue_comment` runs belong to the default-branch tip.
- **Duplicate check runs with the same name.**
  - All `nod` runs on a SHA landed in one check suite (Actions app, that SHA): the verifier's runs from both events and, below, the forged one.
  - GitHub's rollup (`statusCheckRollup`, the merge box) shows **only the newest `nod`**. The older ones stay listed under `filter=all`.
  - In every transition we saw, the newest one won: failure→success (#1), success→failure (#6), and real failure→forged success→real failure (#5).
  - Whether a ruleset also evaluates only the newest is undocumented and could not be tested here (see 2).
- **Repeated events.**
  - With `concurrency: nod-<pr>` and `cancel-in-progress: false`, six comments posted within 6 s produced one finished run, four `cancelled` pending runs and one finished latest run.
  - That is fine, because every run reads the full current state.
  - A **re-run** of an old run (`gh run rerun 44374588554`) uses the old workflow YAML. But it checks out `main` by name, so it picked up the newer `verify.ts` (the requirement changed from `self` to `peer`).
- **Latency, by API timestamps:**

  | Trigger | To check completed |
  |---|---|
  | nod comment (PRs #1, #2 self, #2 peer) | 15 s, 13 s, 12 s |
  | batch comment on 3 PRs | 12 s, 12 s, 14 s |
  | comment edit / delete | 13 s / not timed |
  | push: rebase, new commit, "Update branch" | 19 s, 16 s, 18 s |
  | base change (`edited`) | 16 s |

  - Step breakdown for one run: comment to run queued 3 s, runner start 3 s, checkout (full history) 2 s, `setup-bun` 2 s, `verify.ts` 2–3 s.
  - The script itself took 1.5–2.7 s.

## 2. Ruleset enforcement (not testable on this plan)

All three refused on the private Free repo:

```
POST /repos/…/rulesets                 -> 403 {"message":"Upgrade to GitHub Pro or make this repository public to enable this feature."}
PUT  /repos/…/branches/main/protection -> 403 (same message)
PATCH /repos/… allow_auto_merge=true   -> 200, but the response still says "allow_auto_merge": false
```

- The integration id is verified: `gh api /apps/github-actions` returns `{"id":15368,"slug":"github-actions","owner":"github"}`.
- The ruleset that was attempted (`spikes/…/tools/ruleset.json`):

```json
{ "name": "nod", "target": "branch", "enforcement": "active", "bypass_actors": [],
  "conditions": { "ref_name": { "include": ["~DEFAULT_BRANCH"], "exclude": [] } },
  "rules": [
    { "type": "deletion" }, { "type": "non_fast_forward" },
    { "type": "pull_request", "parameters": { "required_approving_review_count": 0, "dismiss_stale_reviews_on_push": false,
      "require_code_owner_review": false, "require_last_push_approval": false, "required_review_thread_resolution": false } },
    { "type": "required_status_checks", "parameters": { "strict_required_status_checks_policy": false, "do_not_enforce_on_create": false,
      "required_status_checks": [ { "context": "nod", "integration_id": 15368 } ] } } ] }
```

- `tools/prove-ruleset.sh` runs the whole proof point 2 once the sandbox is on Pro or public:
  1. create the ruleset and enable auto-merge;
  2. show that merging is blocked while the check is red;
  3. show that `--auto --squash` waits, then merges after the nod;
  4. try `--admin` with an empty bypass list;
  5. try a commit-status forgery;
  6. try the branch-workflow check forgery with auto-merge armed.
- **Product consequence:** nod needs rulesets, so a **private repo needs GitHub Pro, Team or Enterprise**. On Free it only works for public repos.
- By reading only, not tested:
  - Rulesets are bypassed only through their bypass list (unlike classic branch protection, where admins are exempt unless "include administrators" is set). With an empty list, `--admin` should therefore be refused for the owner too. This needs the test.
  - The owner's `repo` token can edit or delete the ruleset, so an empty bypass list does not stop an agent holding that token.
  - Required checks treat the conclusions `neutral` and `skipped` as passing, so the verifier may only ever conclude `success` or `failure`.

## 3. Patch-id

**Definition (recommended, used by both the signer and the verifier):**

```
mb   = git merge-base <base tip> <head_sha>
diff = git --attr-source=4b825dc642cb6eb9a060e54bf8d69288fbee4904 diff \
         --no-color --no-ext-diff --no-textconv --no-renames --full-index \
         --diff-algorithm=myers --indent-heuristic -U3 --src-prefix=a/ --dst-prefix=b/ mb head_sha
patch_id = first field of (diff | git patch-id --stable)      # "" for an empty diff
env: GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1
```

Each flag fixes something we measured or that depends on local config:

| Flag | Why |
|---|---|
| `-U3` | Context lines are hashed. With `-U0` or `-U10` the patch-id differs. |
| `--full-index` | For binary files the `index` line is hashed. Abbreviated SHAs depend on repo size, so a shallow and a full clone would disagree. |
| `--no-renames` | `-M` and `--no-renames` give different ids, and rename detection depends on `renameLimit`. |
| `--attr-source=<empty tree>` | Stops `.gitattributes` changed by the PR from changing the diff, e.g. by marking a file `-diff`. |
| empty global and system config | Neutralises `diff.algorithm`, `indentHeuristic`, `noprefix` and similar settings. |

The verifier fetches `+refs/heads/<base>` and the head SHA as data, using the job token as an `http.extraheader`, and diffs locally. The API diff (`Accept: application/vnd.github.diff`) is **not usable** as the source:
- It detects renames. On rename PR #3 it gave `7e6e99d8…` while the local diff gave `b8a52704…`.
- It refuses above 300 files: `406 "Sorry, the diff exceeded the maximum number of files (300)…"` on PR #5.
- For plain text changes it matched the local value (PRs #1, #2, #4; #4 is a 25 000-line file).

Evidence on GitHub:

| Step | head_sha | patch-id | nod | check |
|---|---|---|---|---|
| PR #1 nodded | `6ed02f0` | `648319bb…` | matches `head_sha` | success |
| main moves far away, clean rebase, force-push | `ec725e3` | `648319bb…` (local = API) | matches `patch_id`, **no new signature** | success (19 s) |
| new commit changes another line | `d285e32` | different | `stale: neither head_sha nor patch_id matches` | failure |
| PR #2 "Update branch" (merge commit `Merge branch 'main' into pr/core-b`) | `e29e2b1` | unchanged | matches `patch_id` (both nods) | success |
| base edits line 18, PR #1 changes line 20; clean rebase | `c68d62e` | `14085630…` (changed) | stale | failure: a new nod is needed |

Edge cases:
- **Context drift:** if the base changes a line within 3 lines of the PR's change, the patch-id changes even after a clean rebase. This fails safe and costs a re-nod. `-U0` would avoid it but would let a nod survive changes right next to the reviewed lines. Recommendation: keep `-U3` and have the UI explain "base changed next to your change".
- **Rebase with conflict resolution:** the +/- lines change, so the patch-id changes and the PR needs a new nod (by construction).
- **"Evil merge" commits:** an extra change inside a merge commit is part of `mb..head`, so it changes the patch-id.
- **Mode-only changes and empty files** get a patch-id (checked locally).
- **Large PRs:**
  - The files API returns at most 3000 files. PR #5 had 3006; page 31 was empty, and the last file on page 30 was `app/junk/f3000.txt`.
  - With `/pulls/N/files`, the policy saw `requirement: self` for a PR that also changes `core/engine.txt`.
  - Fixed: the file list now comes from `git diff --name-only -z --no-renames mb head`, which returned `requirement: peer`, `files: 3006`.
  - Taking the list from git also took verify from 15.8 s to 1.5 s.
- **Cost:** checking out with `fetch-depth: 0` is fine for small repos. Large repos need a blobless or partial fetch; not measured.

## 4. Batch

`sign.ts … --post 1 3 4` signs one payload with three entries and posts the **same comment body** on each PR:

```
{"v":1,"repo":"FreshlyBrewedCode/nod-sandbox","entries":[
  {"pr":1,"base":"main","head_sha":"c68d62e2…","patch_id":"14085630…"},
  {"pr":3,"base":"main","head_sha":"b511cdb8…","patch_id":"b8a52704…"},
  {"pr":4,"base":"main","head_sha":"4dbe7ec6…","patch_id":"e813d35f…"}],
 "verdict":"approve","level":"review","reviewer":"FreshlyBrewedCode","signed_at":"2026-11-18T18:53:37.944Z"}
```

```
{"pr":1,"nod":[{"conclusion":"success","title":"nodded by FreshlyBrewedCode (self, head_sha)","completed_at":"18:53:52Z"}]}
{"pr":3,"nod":[{"conclusion":"success","title":"nodded by FreshlyBrewedCode (self, head_sha)","completed_at":"18:53:53Z"}]}
{"pr":4,"nod":[{"conclusion":"success","title":"nodded by FreshlyBrewedCode (self, head_sha)","completed_at":"18:53:56Z"}]}
```

Each verifier run looks up the entry for its own PR number.
- Posting the same body on every PR is simple and keeps each PR self-contained: the verifier only reads that PR's comments.
- A comment holds 65 536 characters. At about 130 characters per entry, that is a few hundred PRs per batch.
- An alternative would be one comment that the other PRs point to. That needs cross-PR reads and gives the agent more to tamper with, so we recommend copies.

## 5. Self vs peer

- **Mapping:** the `allowed_signers` principal **is** the GitHub login.
  - Self means `reviewer` equals the PR author's login, case-insensitive. Peer means any other enrolled principal.
  - The comment author is never used: every comment here came from the same user.
  - The payload's `reviewer` is passed as `-I`, so `ssh-keygen` binds the key to that principal.
- Sandbox policy: paths under `core/`, `.nod/` or `.github/` need a peer. Anything else is fine with a self nod.

PR #2 changes `core/`:

```
no nod                          -> failure "waiting for a peer nod"
alice (FreshlyBrewedCode) nod   -> failure "waiting for a peer nod (have: FreshlyBrewedCode (self, head_sha))"
bob nod                         -> success "nodded by FreshlyBrewedCode (self, head_sha), bob (peer, head_sha)"
```

- Logins are case-insensitive but principals are matched exactly. Enrolment should store the login exactly as the API returns it.
- In a one-human repo there is no peer, so `.nod/**` can only change through an admin. This needs a documented path.

## Attacks

The threat: a coding agent with the human's `gh` token (owner, `repo` scope, no `workflow` scope), push access over the human's SSH key, and no signing key.

### Forged check from a branch workflow: **works**

`attacks/forge.yml` is pushed to branch `attack/forge` over SSH. It is not part of any PR and the PR diff stays clean. It has `on: push`, `permissions: checks: write, contents: read`, and runs `gh api -X POST repos/$REPO/check-runs -f name=nod -f head_sha=<PR #5 head> -f conclusion=success`.

```
push 18:59:31Z -> forged run 135054126503 at 18:59:41Z (10 s)
{"pr":5,"merge_state":"CLEAN","rollup":"SUCCESS",
 "nod":[{"id":135054126503,"conclusion":"success","app":"github-actions","suite":120121702453,"title":"nodded by bob (peer, head_sha)"},
        {"id":135051169930,"conclusion":"failure","app":"github-actions","suite":120121702453,"title":"waiting for a peer nod"}, …]}
```

- The forged check run lands in **the same check suite** as the verifier's.
- It has the same app (`github-actions`, id 15368) and the same name.
- `details_url` and `html_url` are just its own run URL, and `external_id` is whatever the creator sets.
- Nothing in the check run records which workflow created it, so neither a ruleset pinned to 15368 nor the verifier can tell the two apart.
- The next real verifier run made it red again ("latest wins"). By then auto-merge would already have merged.
- Enforcement itself is untested (plan), but nothing distinguishes the forged check, so we expect the merge to go through. `prove-ruleset.sh` step 4 confirms it once rulesets are available.

Other paths, tested:

| Attempt | Result |
|---|---|
| Checks API with the user token | `403 "You must authenticate via a GitHub App."` |
| Commit status `nod` with the user token | Created (`creator: FreshlyBrewedCode`) and shown in the rollup as a `StatusContext`. A check pinned to 15368 should not accept it (docs: "was not set by the expected GitHub App"). Enforcement untested. |
| Add a workflow file through the contents API (token without `workflow` scope) | `404 Not Found` |
| Push a workflow file over SSH | Accepted. The scope check only applies to OAuth tokens. |
| PR code run by an ordinary CI workflow (`on: pull_request`, default token; the repo default is `read`) tries to create the check | `gh: Resource not accessible by integration (HTTP 403)` |

### Mitigations evaluated

| Option | Result |
|---|---|
| **A. Self-owned GitHub App, key in environment `nod` (recommended)** | **Holds, for the parts testable here.** Details below. |
| B. No app: limit and detect | Possible, but it rests on the agent's environment. Details below. |
| C. Push ruleset "restrict file paths" `.github/workflows/**` on all branches | Read only, not available here. It would stop new or changed workflow files on any branch, but legitimate workflow changes then need an admin to lift the rule. |
| D. Workflow execution protections (GA 2026-09-17) | Read only. Event rules can be scoped by workflow path. This blocks a *new* forging file but not edits to an allowed `ci.yml` on a branch, which run from the branch. Available for public repos and Team/Enterprise private repos; personal accounts unclear. |
| Required deployments with an environment restricted to `main` | **Rejected, tested.** The REST API created successful deployments in `nod` for ref `attack/forge`, both with the user token and with a branch workflow's `GITHUB_TOKEN`. The branch policy only gates jobs. The verifier's own environment jobs deploy ref `main` at the main tip, not the PR head. |
| Verifier re-asserts on `check_run` / `workflow_run` | **Rejected.** Check runs created with `GITHUB_TOKEN` trigger no workflows (docs). The forger is also faster (10 s vs 12–19 s), auto-merge acts at once, and a forging job can loop for hours. |
| Verifier signs its verdict with an environment secret | **Rejected.** Nothing on GitHub checks the signature, and the gate is GitHub. |
| Merge queue | **Rejected, by reading.** It is only for organization repos. `merge_group` runs the workflow from the merge-group commit, which contains PR code. |

**A. Self-owned GitHub App with its key in environment `nod`.**
- The app is a GitHub App registration with no webhook and no server. It is installed on the repo only, with `checks: write` and `contents/pull-requests: read`.
- Its private key is a secret of environment `nod`, whose deployment branch policy allows only `main`.
- The verifier job declares `environment: nod`, mints an installation token (e.g. `actions/create-github-app-token`, pinned by SHA) and creates the check. The ruleset pins `nod` to the app's id.

Tested:
- A branch job cannot enter the environment: `Branch "attack/forge" is not allowed to deploy to nod due to environment protection rules.` This is enforced even on this Free private repo.
- Both verifier contexts can read the environment secret: `pull_request_target` gives `secret readable (len 25) ref=refs/heads/main`, and `issue_comment` the same.
- The user token cannot create check runs (above).

Not tested:
- Creating the app is an account-level action, which this spike was not allowed to take.
- Pinning the check to a custom app needs rulesets (plan).

Limits:
- This is "a GitHub App" in the registration sense. It goes against the concept's wording "no GitHub App", though not its intent (no backend, no hosting). The owner decides.
- An admin token can still widen the environment policy or delete the ruleset.

**B. No app: limit and detect.**
- Agents push over HTTPS with a token that has no `workflow` scope (tested: 404) and have no SSH key. Ideally they use a fine-grained token without the Administration and Workflows permissions.
- The repo default token stays `read`, and no workflow that runs branch code gets `checks: write` (tested: 403).
- Agent settings forbid `.github/workflows/**`.
- A post-merge audit workflow on `push` to `main` re-verifies each merged PR's nods and opens an alarm issue or reverts.
- This holds only as long as the agent's environment is set up right. It is detection, not prevention.

### Retarget (stacked PR) attack: **worked against the concept rule, fixed**

1. PR #7 targets `feature-x`, a branch carrying an unreviewed change. alice nods it (self, `base: feature-x`), and it turns green.
2. `gh pr edit 7 --base main`: the diff now contains `+app line 35 (UNREVIEWED change on feature-x)`.
3. The verifier re-ran on `edited` and stayed **green: "nodded by FreshlyBrewedCode (self, head_sha)"**, because the head SHA had not changed.

**Fix:** each entry carries `base`, and it only counts when `entry.base == PR base`. After the fix, PR #7 shows `failure "waiting for a self nod"`. The concept rule becomes:
- a nod counts if `base` matches **and** (`head_sha` **or** `patch_id` matches);
- `patch_id` is always computed against the current base.

`edited` must be among the `pull_request_target` triggers, or a retarget keeps the old check. Since 2025-12-08, `pull_request_target` always runs the default branch's workflow (changelog 2025-11-07). An agent can therefore no longer swap in its own workflow by targeting its own base branch. We observed this on run 44376550858 for PR #7 while its base was `feature-x`: the workflow path was `.github/workflows/nod.yml` from `main`, and the probe job printed `secret readable (len 25) ref=refs/heads/main`.

### Replay and scope (PR #6, needs a peer; all comments from the same user)

| Comment | Verifier result |
|---|---|
| bob's valid nod for PR #2, pasted onto #6 | `no entry for this PR` |
| bob's nod with `repo: FreshlyBrewedCode/other-repo` | `nod is for repo FreshlyBrewedCode/other-repo` |
| alice's key, payload claims `reviewer: bob` | `signature invalid: Could not verify signature.` |
| bob's key, namespace `git` | `signature invalid: Couldn't verify signature: namespace does not match` |
| bob's #2 nod with `"pr":2` edited to `"pr":6` | `signature invalid: Signature verification failed: incorrect signature` |
| bob's nod with `verdict: reject` | `verdict reject` |
| old nod after new commits (PR #1) | `stale: neither head_sha nor patch_id matches` |
| valid bob nod on #6 | success |
| …comment edited, payload changed (`issue_comment: edited`) | failure (13 s) |
| …comment edited, only the human line changed | success (the signed block is unchanged) |
| …comment deleted (`issue_comment: deleted`) | failure |

Notes:
- Nods are re-verified on every run against the current `allowed_signers` on `main`. Removing a key therefore revokes its past nods on open PRs.
- `allowed_signers` also supports `valid-after` and `valid-before` for key rotation.
- Deleting a comment can only take a nod away, which is a denial of service and not a bypass.
- Who posted a comment never matters.

### Rules for the real verifier (workflow injection hygiene)

- In `run:` steps, `${{ }}` may only expand **numbers and fixed strings**: the PR number goes into `env:`. Never expand a comment body, title, branch name or label. PR #6's title `$(id) \`id\` ${{ github.token }}` stayed inert.
- Never check out, build, install or run anything from the PR. Fetch its commits as objects only, run `git diff` with `--no-ext-diff --no-textconv` and an empty `--attr-source`, and use empty global and system git config.
- Treat comment bodies as untrusted input:
  - use a strict block regex with length limits (payload ≤ 32 KB, at most 20 blocks per comment);
  - validate `reviewer` against `^[A-Za-z0-9][A-Za-z0-9-]{0,38}$` before passing it to `ssh-keygen`;
  - spawn processes with argument arrays and no shell;
  - write payload and signature to temp files;
  - parse the JSON only **after** the signature verified, then check `repo`, `verdict`, `entries[].pr` and `base`.
- Permissions: `permissions: {}` at workflow level. The verify job gets `checks: write, contents: read, pull-requests: read, issues: read`. A sticky comment would add `issues: write`. Use `persist-credentials: false`.
- Take the policy's file list from git, never from the files API (3000-file cap).
- Conclude only `success` or `failure`; `neutral` and `skipped` pass required checks.
- Name the job anything but `nod`.
- Pin third-party actions by SHA. They run inside the job that holds the token, and with option A the app key.
- From **2026-12-02**, `pull_request_target` is blocked by default in public repos by a GitHub default rule (workflow execution protections, changelog 2026-09-17). The setup PR has to add an event policy that allows it for `.github/workflows/nod.yml`. Read only, not tested.

### Other ways to merge without a nod, short of `--admin`

- **Owner token = admin.** With it an agent can change or delete the ruleset, the environment policy and Actions settings, which is equivalent to `--admin`. Only a token without Administration permission closes this.
- **SSH key.** The `workflow` scope gap only protects HTTPS and API pushes; the human's SSH key gets around it.
- **CI with `checks: write`.** Any existing workflow that runs branch code with `checks: write` (some test reporters ask for it) can forge `nod`. The repo default token permission is only a default; a workflow file can request more.

## Recommended comment format

````
**nod** · approve · review · by `bob` · #2

```nod
{"v":1,"repo":"FreshlyBrewedCode/nod-sandbox","entries":[{"pr":2,"base":"main","head_sha":"55398e0…","patch_id":"…"}],"verdict":"approve","level":"review","reviewer":"bob","signed_at":"2026-11-18T18:43:33.000Z"}
-----BEGIN SSH SIGNATURE-----
…armored SSHSIG, namespace "nod"…
-----END SSH SIGNATURE-----
```
````

- The signature covers **exactly the bytes of the payload line**, with no trailing newline. The verifier never re-serialises it.
- The signer emits keys in a fixed order with no whitespace.
- The human line above the block is free text and is not signed.
- `\r` is stripped before verifying, because web edits can introduce CRLF.

## Measured latencies (summary)

| Path | Seconds |
|---|---|
| nod comment → `nod` check | 12–17 |
| push / rebase / update-branch → `nod` check | 16–19 |
| branch push → **forged** `nod` check | 10 |
| verify.ts itself | 1.5–2.7 (15.8 with files-API pagination over 3006 files) |

## Open questions for the owner

1. **Plan.** Make the sandbox Pro (or public) so `prove-ruleset.sh` can settle proof point 2, `--admin` and forgery under enforcement. nod on private repos needs Pro, Team or Enterprise.
2. **App or no app.** Accept a self-owned, backend-less GitHub App (option A)? Without it, the gate rests on how the agent's environment is set up (option B).
3. **Agent credentials.** Concept: agents share the human's token. Should nod instead recommend a fine-grained token without Administration and Workflows, and no SSH key? That closes both the admin bypass and the forged workflow file.
4. **Context lines.** Keep `-U3` (re-nod after nearby base edits) or move to `-U0`?
5. **`level`.** What does it mean? The spike carried it (`review`) but did not use it.
6. **One-human repos.** How do they change `.nod/**` when the policy needs a peer?
7. **Execution protections.** Are they available on personal-account repos? Do they need setup because of the 2026-12-02 `pull_request_target` default?

## Sandbox state (left for later tasks)

- **Repo:** `FreshlyBrewedCode/nod-sandbox`, private.
- **No ruleset** (refused). Auto-merge is off (refused).
- **Environment `nod`:**
  - branch policy `main`;
  - secret `NOD_ENV_PROBE`, a non-sensitive probe value;
  - many deployments from the probe job.
- **`main`:**
  - the final verifier: strict base, file list from git, plus the `env-probe` job;
  - `ci.yml`;
  - `allowed_signers` with alice and bob.
- **Open PRs:**
  - #1 (app change; green from the batch nod);
  - #2 (core change; green from alice + bob, after "Update branch").
- **Closed evidence PRs:** #3–#7.
- **Branches:**
  - `attack/forge` holds the forging workflows. A push to `attack/**` re-runs them; `prove-ruleset.sh` uses this.
  - `feature-x` holds the retarget setup.
- **Keys:** kept outside the repo in the spike's local scratch directory. They are never committed and were never added to GitHub or `~/.ssh`.

# 0001: Nod format and when a nod counts

Status: accepted (2026-11-18). Evidence: [finding 01](../findings/01-spike-1-github-mechanics.md). Rule 9 amended by [ADR 0006](0006-opt-in-ladder.md): `neutral` while the check is not enforced.

## Decision

1. **Payload.** One line of JSON, keys in this order, no whitespace:
   `{"v":1,"repo":"owner/name","entries":[{"pr":2,"base":"main","head_sha":"…","patch_id":"…"}],"verdict":"approve","level":"review","reviewer":"<login>","signed_at":"<ISO time>"}`
2. **Signature.** SSHSIG over exactly the bytes of that line (no trailing newline), namespace `nod`, made by an ed25519 key. The verifier never re-serialises the payload; it parses the JSON only after `ssh-keygen -Y verify` accepted it.
3. **Comment.** A free-text human line, then a fenced `nod` block holding the payload line and the armored signature. The human line is not signed. Who posted the comment never matters.
4. **Batch.** One payload lists several entries; the same comment body is posted on each PR. Each verifier run reads only its own PR's comments and looks up its own entry.
5. **A nod counts for a PR when** `repo` matches, the entry's `pr` matches, `verdict` is `approve`, the entry's `base` equals the PR's current base branch, **and** the entry's `head_sha` **or** `patch_id` matches the PR now. This adds `base` to the concept's rule: without it a retargeted stacked PR kept its nod while pulling in unreviewed content.
6. **Patch-id.** Computed locally by both the signer and the verifier, never from the API diff:
   `git diff` between `merge-base(base tip, head)` and `head` with pinned flags (`--no-color --no-ext-diff --no-textconv --no-renames --full-index --diff-algorithm=myers --indent-heuristic -U3`, empty-tree `--attr-source`, empty global and system config), piped through `git patch-id --stable`.
   - We keep `-U3`: a base edit within three lines of the change costs a new nod. That fails safe, and the UI explains it.
7. **Self or peer comes from the signature.** The principal in `.nod/allowed_signers` is the GitHub login. `reviewer` equal to the PR author (case-insensitive) is a self nod; any other enrolled principal is a peer.
8. **`level`** is `review` for a nod. It is reserved for weaker or stronger attestations later (e.g. "skimmed", "tested") and the v1 policy does not read it.
9. **The verifier concludes only `success` or `failure`**, on its own check run named `nod`. The workflow job must not be named `nod`.

## Consequences

- Removing a key from `allowed_signers` revokes its nods on open PRs, since every run re-verifies.
- The policy's file list comes from git, not from the files API (capped at 3000 files).
- The hygiene rules in finding 01 ("Rules for the real verifier") are requirements for `.nod/verify.ts` and the workflow.

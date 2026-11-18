# Spike 1: GitHub-side mechanics (evidence)

**Not production code.** These are the throwaway scripts and the sandbox files behind
[`docs/findings/01-spike-1-github-mechanics.md`](../../docs/findings/01-spike-1-github-mechanics.md).
They are kept as evidence, not as a starting point to copy from.

| Path | What it is |
|---|---|
| `sandbox/.nod/verify.ts` | The spike verifier, as last pushed to `main` of the private sandbox `FreshlyBrewedCode/nod-sandbox`. |
| `sandbox/.nod/lib.ts` | Patch-id, canonical payload, comment block regex. The signer and the verifier share it. |
| `sandbox/.nod/allowed_signers` | Public keys of the fictional signers alice (principal `FreshlyBrewedCode`) and bob (principal `bob`). |
| `sandbox/.github/workflows/nod.yml` | The verifier workflow (`pull_request_target` + `issue_comment`), with a probe job for environment access. |
| `sandbox/.github/workflows/ci.yml`, `sandbox/ci.sh` | An ordinary CI workflow that runs PR code with the default read-only token. |
| `attacks/forge.yml` | A branch workflow that forges a green `nod` check on another PR's head SHA. It worked. |
| `attacks/env-probe.yml` | A branch workflow that tries to enter environment `nod` (it was rejected) and to fake a deployment (that worked). |
| `attacks/ci-forge.sh` | PR code run by CI that tries to forge the check with CI's token (403). |
| `tools/sign.ts` | The local signer: builds the payload for one or more PRs, runs `ssh-keygen -Y sign -n nod`, posts the comment. |
| `tools/checks.ts` | Waits for a fresh `nod` check run on a PR head, then prints the runs and GitHub's status rollup. |
| `tools/attack-api.ts` | Attempts made with the human's `gh` token: workflow via the contents API, deployments, raw calls. |
| `tools/replay.sh` | The replay and scope attacks (pasted, other repo, wrong key, wrong namespace, tampered, rejected verdict). |
| `tools/patch-id-experiments.sh` | Local experiments on what `git patch-id --stable` hashes. |
| `tools/ruleset.json` | The ruleset that was refused on the Free plan. |
| `tools/prove-ruleset.sh` | Proof point 2 plus the forgery under enforcement. **Not run yet**, because the plan refused rulesets. |

The scripts expect a working layout with `tools/`, a clone of the sandbox at `sandbox/` and the
throwaway keys at `keys/` side by side. The keys are never committed.

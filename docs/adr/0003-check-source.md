# 0003: Who creates the `nod` check

Status: proposed (2026-11-18). Waiting for the owner's decision; v1 builds mode 1 with the seam for mode 2.

## Context

Finding 01 showed that a workflow pushed on any branch can create a check run named `nod` from the GitHub Actions app. GitHub cannot tell it from the verifier's, and neither can a ruleset pinned to that app. An agent with push access (and the right to push workflow files) can therefore turn the check green without a nod.

The same agent, when it holds the owner's token, can also delete the ruleset. So the check source is one of two doors, and closing only one buys little.

## Decision (proposed)

The verifier creates the check through a small seam, with two modes:

1. **Actions mode (default in v1).** The check comes from the workflow's `GITHUB_TOKEN`, and the ruleset pins it to the GitHub Actions app. No extra setup. Limit, documented in the setup PR: nod then guards against mistakes and unattended merges, not against an agent that deliberately pushes a forging workflow. Recommended with it: agents push with a token that has no `workflow` scope and no Administration permission.
2. **App mode (hardening, later).** A GitHub App registration owned by the user, with no webhook and no server. Its key is a secret of an environment that only the default branch may use; the verifier mints a token from it, and the ruleset pins `nod` to that app. Tested in the spike as far as possible without creating the app.

## Consequences

- `.nod/verify.ts` takes the check token from one place, so switching modes changes the workflow and the ruleset, not the verifier's logic.
- The setup PR states the mode and its limit in plain words.

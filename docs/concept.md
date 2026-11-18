# nod: concept

> Status: concept from the launch brainstorm on 2026-11-18. This is the source of truth for decisions until ADRs replace parts of it.
> Name: **nod**, published as `@frebreco/nod`, on the `frebreco.de` domain.
> The design mockups (`docs/design/`) still use the earlier working name "Countersign"; read it as "nod".

## Why

Coding agents write most of our code now, and each one opens PRs. A team of 2–3 people ends up with far more PRs than anyone can follow. Review has changed: it is less about reading code and more about **staying on top of what is happening**. PRs fall into three kinds:

- **Auto:** low risk. It can merge in the background without anyone looking.
- **Decide:** needs a specific human's input or a second pair of eyes.
- **FYI:** shares knowledge. Nobody needs to give input, but people should notice it and roughly understand what was done.

GitHub's model ("at least one approval, not the author") no longer fits:

- Agents use the user's own `gh` token, so the human who prompted a change shows up as its author and cannot approve it.
- There is still real value in "a human looked at this", even when that human prompted the agent.
- Which changes need extra eyes, and whose, depends on the change: paths, size, our module tiers, and so on.

Approval must also not become the bottleneck, for humans or for agents waiting to continue.

**nod** is two things:

1. **A dashboard that steers attention.** It shows what needs *me* now, what is worth knowing, and what is happening in the background. Each item gets screen space in proportion to the attention it deserves.
2. **A lightweight human attestation layer** on top of GitHub. A human signs a nod with a key the agents don't have, a required check enforces policy, and then agents can merge on their own.

nod must be lightweight. There is no GitHub App, no backend and no hosted infrastructure we have to run. It runs on your machine, uses the existing `gh` credentials, and keeps **all shared state in GitHub**.

## Decisions

### Product
1. **Scope v1:** one repo, 2–3 people, about 50–100 merged PRs per two weeks. Polling GitHub is fine.
2. **Policy as TypeScript**, in one central file read from the **base branch**.
   - Composable built-in **classifiers**: file paths, diff size, dependencies, migrations, and so on.
   - Teams add **custom classifiers**. Our example is a domain classifier for module type and tier, and for "pure module update" vs "touches core".
   - Classifiers emit facts and tags. **Policies** map those to a category and a **requirement**: none (auto-merge), the prompter self-attests, another human, or a named person.
   - The policy is mostly deterministic. An LLM step may only *raise* risk. Intent declared by the agent may only raise attention or risk.
3. **Signed attestations ("nods")** over `{repo, entries:[{pr, head_sha, patch_id}], verdict, level, reviewer}`.
   - A nod stays valid if `head_sha` **or** `patch_id` still matches. A clean rebase keeps the approval; a content change needs a new nod.
4. **Batch approval:** select several PRs, unlock once and sign once. One signature covers many entries. A batch may mix your own PRs and others', and the verifier decides per PR whether the signature counts as self or peer.
5. **Agents may merge**, using auto-merge, once the required check is green. Only `gh pr merge --admin` is blocked in agent settings.
6. **FYI acks are unsigned**: a reaction or a light marker. A PR is FYI because of policy rules or because the author or agent declared it.
7. **Deep links:** PR comments posted by the verifier or by agents carry links that open the PR or a batch in the UI, ready to approve. **A link never approves by itself.**
8. **Agent integration:**
   - a PR brief template or skill: what, why, risk, how it was verified, where to look, `Epic: #n`, `Depends on #n`;
   - a CLI or MCP for agents: "what does my PR need", "ask @x", "is it attested".

### UI (from three design rounds; final reference: `docs/design/r3/`)
9. **Visual language:** direction A, a dark, calm, keyboard-driven inbox. Density is kept low on purpose, using progressive disclosure.
10. **Views:**
    - **List** with a toggle "By attention | Chronological". Chronological is sorted by last activity, and low-risk items are folded per time bucket.
    - **Board** with group-by "Waiting on" (the default), State, or Epic.
11. **Attention-proportional space.** Four tiers come from five rules, and the first rule that matches wins. See `docs/design/r3/README.md` for the exact rules:

    | Tier | Applies to | Shown as |
    |---|---|---|
    | 1 | Needs me, and high risk or a teammate's work | Prominent: row plus one line of the brief |
    | 2 | Needs me, my own work, low or medium risk | Normal row |
    | 3 | FYIs I haven't acked; my own open PRs that are stuck or high risk | One line |
    | 4 | Everything else | Folded into an expandable "N low-risk changes" |

    - A teammate's PR that needs me ranks above my own.
    - An open high-risk PR is never folded.
    - Folded items and one-line items have no checkbox for signing.
12. **PR detail:** a resizable side panel in the list (about 380–900 px), an overlay drawer on the board. It opens with the brief and "Needed from you", then a compact timeline of the PR's history. Classifier reasons, signatures, FYI acks and files are folded sections. The panel is closed by default, and its open state and width are remembered.
13. **Diff indicator:** `+312 −88` plus a quiet bar on a log scale, ignoring lockfiles and generated files.
14. **Batch dialog:**
    - one sentence summing it up, rows grouped by your role, and the outcome for each PR;
    - exact SHAs and patch-ids behind a disclosure;
    - the passphrase is entered inside the same dialog;
    - a global lock chip with a countdown shows when signing is unlocked;
    - rows you never opened are marked "not opened" when you sign them as peer or owner.
15. **Epic grouping in v1:** no epic headers and no epic page. Epic is a filter, and rows carry "unblocks / needs first" hints taken from brief lines and stacked-PR base branches. An epics view built on GitHub issues and sub-issues comes later; the design is ready in `docs/design/r2/`.
16. **Onboarding:** a few steps.
    1. Detect the `gh` login and pick a repo.
    2. If the repo is not set up, show what the one-time setup PR adds.
    3. Create or pick a signing key and enrol it through the repo.
    4. Make a test signature.

    Then a first-run dashboard with a legend explaining the tiers and lanes.

## Architecture

### Two halves, the same shape as `~/src/canvas`
1. **`nod serve`:** a local Bun server, published as a CLI in `@frebreco/nod`.
   - Gets the user's token from `gh auth token` and polls GitHub GraphQL, about every 60 s, with ETag.
   - Holds the unlocked signing key in memory and posts nod comments.
   - Exposes **one token-guarded WebSocket used only by the user's own browser**, the model of canvas ADR 0001.
   - Keeps no state beyond a cache.
2. **Web app:** a Vite + React 19 + Tailwind v4 SPA with shadcn-style primitives.
   - Hosted on GitHub Pages with stable and `next` channels: `ui.nod.frebreco.de`, and `ui.nod.frebreco.de/next`. Locally it runs on the Vite dev server.
   - It talks to `nod serve` over loopback.
   - Deep links point at the hosted UI. They are stable public URLs that do nothing until the page is paired with the local server: the token from the host link is kept in that origin's storage.
   - `src/shared/protocol.ts` is the contract between the two halves.

**Release, the same as canvas:**
- semantic-release; PRs are squash-merged, and the PR title is the conventional commit.
- Every merge to `main` publishes `@next` and deploys `ui…/next`.
- `release.yml`, run by hand, publishes `latest` and deploys the root UI to a separate `nod-ui` Pages repo.
- The published CLI opens the web app of its own release channel.
- The site and docs live at `nod.frebreco.de`.

### The repo owns the critical logic
The policy engine and everything that runs on the GitHub side live **in the user's repository**, not inside a black-box npm package. `nod init` opens a setup PR that adds:

```
.nod/
  policy.ts            # composes classifiers → category → requirement (repo-owned)
  classifiers/         # custom classifiers, e.g. module tier
  verify.ts            # the whole verifier flow, readable top to bottom
  allowed_signers      # trust root: humans' public signing keys (OpenSSH format)
  package.json, bun.lock   # pins the helper kit; Dependabot can bump it
.github/workflows/nod.yml  # pull_request_target + issue_comment; checks out the BASE ref only, never PR code
```

- **`@frebreco/nod/kit`** (a subpath export of the same package) contains only pure helpers:
  - built-in classifiers and requirement combinators;
  - nod comment parsing and patch-id;
  - GitHub fetch helpers;
  - the sticky comment renderer.
- **The crypto is done by OpenSSH, not by our code.** `verify.ts` calls `ssh-keygen -Y verify` with the repo's `allowed_signers` and the namespace `nod`.
- **The verifier is the single source of truth.** Each run it:
  - classifies the PR;
  - works out the requirement;
  - verifies the nods;
  - sets the required check `nod` **on the PR head SHA**, through the Checks API;
  - syncs labels, which are display only and never read by the gate;
  - writes one sticky comment;
  - writes a machine-readable summary into the check run output.

  The local app reads that summary. It does not run repo code itself.
- The repo's required-approvals count is lowered to 0, and a ruleset requires the `nod` check from the GitHub Actions source instead.

### Trust model
- **Signing keys are trusted from `.nod/allowed_signers` on the base branch, not from GitHub's SSH-keys API.**
  - Registering keys on GitHub would need the `admin:ssh_signing_key` scope on the shared `gh` token, and with it any agent could register its own key and forge nods.
  - Enrolling a key is a PR to `allowed_signers`. It touches `.nod/**`, so policy puts it at the highest risk and a peer must nod it.
  - Changes to the policy, the verifier and the workflow are gated the same way.
  - The repo's first setup PR merges under the old one-approval rule, and the PR says so.
  - A pending key can view everything but sign nothing.
  - (Recommended in the launch; the user went ahead to build without objecting. Confirm with a quick yes.)
- **Signer:** an ed25519 key encrypted with the passphrase (scrypt + AES-GCM) under `~/.config/nod`.
  - It is decrypted into the server's memory for N minutes (15 by default) and produces SSHSIG, so plain `ssh-keygen` verifies it.
  - Signing methods are pluggable. Touch ID or Secure Enclave, or 1Password, come later, through an ssh-agent that confirms each signature. Most of the team is on Macs.
- **Known limits of passphrase mode, documented honestly.** While signing is unlocked, an agent running as the same user could drive the browser, or attach a debugger to the server process (this depends on the OS and its ptrace settings). Passphrase mode guards against mistakes more than against a determined agent; per-signature Touch ID closes this gap. Admin tokens can still bypass rulesets.

### Spike 1: prove the GitHub-side mechanics before any UI
1. Sign locally and post the comment. `issue_comment` then triggers the verifier, and a check run appears on the PR **head SHA**. `pull_request_target` jobs report on the base commit, so the check run has to be created explicitly.
2. A ruleset requires that check, pinned to the GitHub Actions source, and blocks merging until it is green. Auto-merge then merges.
3. The patch-id stays stable through a clean rebase and changes when content changes.
4. One batch signature verifies across 3 PRs.

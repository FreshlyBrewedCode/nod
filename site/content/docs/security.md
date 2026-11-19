---
title: Security and limits
description: What nod guards against, what it does not, and the settings that make the difference.
section: Your repository
order: 4
---

> **nod is a prototype.** In its current form it guards against mistakes and unattended merges.
> It does not stop an agent that sets out to get around it. This page says exactly where the
> gaps are.

## The trust model

nod assumes this setting: coding agents run on your machine, as your user, with your `gh` login
and often your git credentials. They are not malicious, but they are fast, numerous, and
sometimes wrong, and nobody watches every step.

Against that, nod places three things:

1. **A signing key the agents don't have.** It is encrypted with a passphrase only you know, and
   a nod is a signature by that key. [Signing keys](/docs/keys)
2. **A trust root the agents cannot change alone.** The list of keys, the policy and the
   verifier live under `.nod/` in your repository, and every change there needs a peer nod.
3. **A required check.** GitHub refuses to merge until the verifier's `nod` check is green, and
   the ruleset has an empty bypass list.

## What nod guards against

- **An unattended merge.** A pull request that the policy says needs a human does not merge
  until a human nodded it.
- **A replayed or forged nod.** A nod pasted from another pull request, a nod for another
  repository, a nod with an edited payload, a nod that claims another reviewer, a nod signed in
  another namespace: all are rejected. The signature covers the payload, and the payload names
  the repository, the pull request, its base and its content.
- **Content changing after the nod.** A nod is bound to the head commit or the patch-id. New
  content needs a new nod. Retargeting a pull request to another base drops the nod.
- **A pull request lowering its own bar.** The policy, the classifiers' trusted inputs and the
  allowed signers are read from the default branch, never from the pull request. A declared risk
  can only raise.
- **A self-registered key.** Keys are trusted from the repository file, not from the GitHub
  account, so the shared `gh` login cannot add one.
- **A hidden change in a huge pull request.** The file list comes from `git`, not from the files
  API with its 3,000-file cap.
- **A crashed verifier.** It fails closed: red, never green.
- **A link that approves.** Deep links only open views.

## What nod does not guard against

### The forgeable check

In v1 the `nod` check is created by the workflow's own token, so it comes from the GitHub Actions
app, like every workflow's checks. **Anyone who can push a workflow file to any branch can create
a green check named `nod` from the same app.** GitHub cannot tell the two apart, and neither can
a ruleset pinned to that app. With auto-merge armed, the pull request then merges.

This was tested: a forged check merged a pull request under an active ruleset within seconds.

So in this mode nod is not a boundary against an agent that deliberately pushes a forging
workflow. The fix is planned and not built: a GitHub App registration that you own, with no
server behind it, whose key only the default branch's workflow can use. The ruleset then pins the
check to that app. See [Status](/docs/status#not-built).

### Owner and admin tokens

A token with admin rights on the repository can change or delete the ruleset, which is the same
as merging with `--admin`. If your agents use such a token, the gate is theirs to open.

### Other ways around it

- **Your SSH key.** A `gh` token without the `workflow` scope cannot add workflow files through
  the API, but a push over SSH with your key can.
- **A CI workflow with `checks: write`.** Any workflow that runs branch code with that
  permission can create a `nod` check.

### Passphrase mode

The signing key is unlocked with a passphrase, into the memory of `nod serve`, for a window of
15 minutes or for one signature.

- While signing is unlocked, an agent running as your user could drive your browser, or attach a
  debugger to `nod serve` and read the key. Whether the second works depends on the operating
  system.
- Any process of your user can copy the key file and guess passphrases offline. scrypt makes each
  guess cost 128 MiB and a fraction of a second. A weak passphrase does not survive that.
- An agent could replace the key file with a key of its own. That key is not enrolled; enrolling
  it is a pull request under `.nod/`, which a peer must nod.

So passphrase mode guards against mistakes more than against a determined agent. Signing methods
that confirm each signature outside the process, such as Touch ID or 1Password through an SSH
agent, close the first gap. They are planned and not built.

## Recommended agent settings

These close most of the gaps above without any change to nod.

- Give agents a token **without the `workflow` scope**. With fine-grained tokens: without the
  Administration and Workflows permissions.
- Give agents **no SSH key that can push**. Let them push over HTTPS with that token.
- In the agents' instructions, forbid `gh pr merge --admin` and changes to
  `.github/workflows/**`.
- Keep the repository's default workflow token permission at read, and give no workflow that
  runs branch code `checks: write`.
- Prefer **just this once** when you unlock, or lock from the chip when you are done.
- Keep the host link to yourself. While signing is unlocked, a page with that link can sign.

## The local server

`nod serve` listens on `127.0.0.1` only. It has one WebSocket, guarded by a pairing token and an
origin check: only the web app's origin, and the local dev server, may connect. The token is in
the link `nod serve` prints and is kept in `$XDG_CONFIG_HOME/nod/serve-token`; `--new-token`
replaces it. The passphrase is sent over that socket once per unlock and is never logged.

Your GitHub token comes from `gh auth token` and is sent only to your GitHub host's API.

## Reporting a problem

Open an issue on [GitHub](https://github.com/FreshlyBrewedCode/nod/issues). nod is a prototype
without a security process; do not rely on it where a bypass would be costly.

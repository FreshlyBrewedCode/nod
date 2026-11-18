# 0002: The trust root is `.nod/allowed_signers` in the repo

Status: proposed, built on meanwhile (2026-11-18). Waiting for the owner's confirmation.

## Decision

Signing keys are trusted from `.nod/allowed_signers` on the base branch (OpenSSH format, principal = GitHub login), not from the SSH signing keys on a GitHub account.

## Why

- Registering a key on GitHub needs the `admin:ssh_signing_key` scope on the `gh` token. Agents share that token, so any agent could register its own key and forge nods.
- A file in the repo needs no extra scope and makes the list of signers reviewable.

## Consequences

- Enrolling or removing a key is a PR that touches `.nod/**`. The policy puts it at the highest risk, so a peer must nod it.
- The first key is part of the setup PR, which merges under the repo's old rule.
- A pending key can read everything and sign nothing.
- A repo with one human has no peer. Changing `.nod/**` there needs the owner to bypass the ruleset by hand; the setup documents this.

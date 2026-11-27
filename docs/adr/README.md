# Architecture decision records

Decisions go here as `NNNN-title.md`, one per file: context, decision, consequences. Until an ADR replaces a part of it, [`docs/concept.md`](../concept.md) is the source of truth; an ADR that does so says which section it supersedes.

| ADR | Decides |
| --- | --- |
| [0001](0001-nod-format-and-validity.md) | The nod format, and when a nod counts |
| [0002](0002-trust-root-in-the-repo.md) | The trust root is `.nod/allowed_signers` in the repo |
| [0003](0003-check-source.md) | Who creates the `nod` check |
| [0004](0004-signer.md) | The signer: an encrypted key file, a session unlock, SSHSIG |
| [0005](0005-named-host.md) | Another device reaches `nod serve` through one named host, same origin |
| [0006](0006-opt-in-ladder.md) | The opt-in ladder: approvals count, the check is neutral until enforced |
| [0007](0007-many-repositories.md) | Many repositories: the repo list, own clones, hosts side by side, protocol 2 |
| [0008](0008-the-app.md) | The app is the one `nod serve` serves on loopback: Host check, service worker, service, updates, badge |

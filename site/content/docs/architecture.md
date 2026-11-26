---
title: Architecture
description: The two halves, the kit, the protocol between them, and where the truth lives.
section: Reference
order: 3
---

```
 your machine                                   GitHub
┌───────────────────────────────┐              ┌──────────────────────────────────┐
│ web app (browser)             │              │ your repository                  │
│   │ one WebSocket, loopback   │   GraphQL    │   .nod/policy.ts, verify.ts,     │
│ nod serve ────────────────────┼─────────────▶│   allowed_signers                │
│   holds the unlocked key      │   comments   │   .github/workflows/nod.yml      │
│   reads gh's token            │              │ pull requests, the check `nod`   │
└───────────────────────────────┘              └──────────────────────────────────┘
```

## Two halves

**`nod serve`** is a local Bun server.

- It takes your token from `gh auth token` and polls GitHub with one GraphQL query, every 60
  seconds, faster for two minutes after you act.
- It reads the verifier's [summary](/docs/verifier#the-summary) from each pull request's `nod`
  check. It never runs your repository's policy or any code from a pull request.
- It computes patch-ids in your clone, holds the unlocked signing key in memory, signs, and
  posts nod comments.
- It keeps no state beyond a cache. The only files it owns are the signing key and the pairing
  token.

**The web app** is a single-page app (React). It talks only to `nod serve`, over one WebSocket on
loopback, guarded by a pairing token and an origin check. It never talks to GitHub. It is meant
to be hosted as static files at `ui.nod.frebreco.de`, and does nothing until paired with a local
server; today it runs from the Vite dev server of a checkout. On another device it is the copy
`nod serve` serves itself on the [named host](/docs/phone), over `wss` to that same address.

## The protocol

`src/shared/protocol.ts` is the contract between the two. The server pushes state: a `welcome`,
then a full `snapshot` of the pull requests on every change, `signer` on every change of the key
(unlock, lock), `setup` on every change of the repository's setup. The web app sends requests
such as `unlock`, `sign` and `ack-fyi`, and each gets exactly one reply.

The snapshot is already relative to you: which pull requests are yours, which need you, what the
ask is. The layout, meaning tiers, lanes, time buckets and board columns, is computed in the
browser by pure functions in `src/shared/attention.ts`.

A release's CLI and web app are built from the same tag, so both speak the same protocol; the
`next` CLI opens the `next` web app.

## The kit

`@frebreco/nod/kit` is a subpath of the same package: the pure helpers your repository's
`.nod/policy.ts` and `.nod/verify.ts` import, also used by `nod serve`. It has no dependencies.

- the nod format: serialise, render and parse the comment;
- signatures through `ssh-keygen`, the patch-id and the file list through `git`, both spawned
  with argument arrays, never through a shell;
- the built-in classifiers, `definePolicy`, the requirement combinators;
- which nods count, the check's summary, the sticky comment;
- GitHub REST helpers and the host's endpoint shapes.

Your repository pins the kit in `.nod/bun.lock`, so the verifier does not change until you bump
it in a pull request, which needs a peer nod.

## Where the truth lives

| What | Where |
| --- | --- |
| What a pull request needs | `.nod/policy.ts` on the default branch |
| Who can nod | `.nod/allowed_signers` on the default branch |
| The nods | Comments on the pull requests |
| The verdict | The check run `nod` on the head commit |
| FYI acks | 👀 reactions on the pull requests |
| Your private key | `signing-key.json` on your machine |

Nothing is stored anywhere else. Delete `nod serve` and the web app, and the gate still works:
a nod can be made by hand with `ssh-keygen -Y sign -n nod` and posted with `gh pr comment`.

## The decisions behind it

The repository keeps its decision records under
[`docs/adr/`](https://github.com/FreshlyBrewedCode/nod/tree/main/docs/adr) and the evidence from
trying the mechanics on GitHub under
[`docs/findings/`](https://github.com/FreshlyBrewedCode/nod/tree/main/docs/findings).

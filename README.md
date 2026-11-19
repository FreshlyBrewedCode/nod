# nod

Steer your team's attention across agent-written pull requests, and let humans nod them through with a signed attestation, so agents can merge on their own.

Local-first: runs on your machine with your existing `gh` credentials, keeps all shared state in GitHub, and keeps the policy and verifier in your own repository.

Status: early prototype, nothing released yet. The user docs are in [`site/content/docs/`](site/content/docs/introduction.md) (the site for `nod.frebreco.de`, not deployed yet: `cd site && bun install && bun run preview`); the why and the decisions are in [`docs/concept.md`](docs/concept.md).

## Development

```sh
bun install
bun run check   # format, lint, typecheck, test
bun run dev     # web app on http://localhost:4517
bun run serve   # local server on :4518, run inside a clone of the repo (--fake: demo data)
```

`nix develop` gives a shell with the pinned Bun and browser-automation libraries.

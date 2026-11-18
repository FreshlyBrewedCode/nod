#!/usr/bin/env bash
# Spike: replay / scope attacks against PR $1 (needs a peer nod). NOT production code.
# Every comment is posted by the same GitHub user; only the signature may matter.
set -euo pipefail
PR="$1"; DONOR_COMMENT="$2"   # a valid bob nod comment from another PR
here="$(cd "$(dirname "$0")" && pwd)"; S="$(dirname "$here")"; R="$S/replay"; mkdir -p "$R"
sign() { bun "$here/sign.ts" --clone "$S/sandbox" "$@"; }
gh api "repos/FreshlyBrewedCode/nod-sandbox/issues/comments/$DONOR_COMMENT" --jq .body > "$R/1-pasted-from-other-pr.md"
sign --key "$S/keys/bob" --reviewer bob --payload-repo FreshlyBrewedCode/other-repo "$PR" > "$R/2-other-repo.md"
sign --key "$S/keys/alice" --reviewer bob "$PR" > "$R/3-alice-key-claims-bob.md"
sign --key "$S/keys/bob" --reviewer bob --namespace git "$PR" > "$R/4-namespace-git.md"
sed "s/\"pr\":[0-9]*,/\"pr\":$PR,/" "$R/1-pasted-from-other-pr.md" > "$R/5-tampered-pr-number.md"
sign --key "$S/keys/bob" --reviewer bob --verdict reject "$PR" > "$R/6-verdict-reject.md"
for f in "$R"/*.md; do
  echo "$(basename "$f"): $(gh pr comment "$PR" -R FreshlyBrewedCode/nod-sandbox --body-file "$f")"
done
date -u +%FT%TZ

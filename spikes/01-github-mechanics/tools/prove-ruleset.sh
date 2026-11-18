#!/usr/bin/env bash
# Spike, proof point 2 + forgery under enforcement. NOT YET RUN: the private sandbox on GitHub Free refused
# rulesets, branch protection and auto-merge ("Upgrade to GitHub Pro or make this repository public").
# Run it once the sandbox is on Pro (or public). NOT production code.
#
# Usage: prove-ruleset.sh            (from this directory; expects ../sandbox clone and ../keys)
set -euo pipefail
R=FreshlyBrewedCode/nod-sandbox
here="$(cd "$(dirname "$0")" && pwd)"; S="$(dirname "$here")"; SB="$S/sandbox"
ts() { date -u +%FT%TZ; }
newpr() { # newpr <branch> <file> <sed-expr> <title>
  git -C "$SB" fetch -q origin main && git -C "$SB" checkout -q -B "$1" origin/main
  sed -i "$3" "$SB/$2" && git -C "$SB" commit -qam "$4" && git -C "$SB" push -q -f -u origin "$1"
  gh pr create -R "$R" --head "$1" --base main --title "$4" --body "spike: prove-ruleset" | grep -o '[0-9]*$'
}
state() { gh pr view "$1" -R "$R" --json state,mergeStateStatus,autoMergeRequest,mergedAt --jq '{state,mergeStateStatus,auto:(.autoMergeRequest!=null),mergedAt}' -c; }

echo "== ruleset + auto-merge"
gh api -X POST "repos/$R/rulesets" --input "$here/ruleset.json" --jq '{id,name,enforcement,bypass_actors}' -c
gh api -X PATCH "repos/$R" -F allow_auto_merge=true -F delete_branch_on_merge=true --jq '{allow_auto_merge}' -c

echo "== 2a: blocked while red, auto-merge waits, merges when green"
H=$(newpr spike/h app/hello.txt 's/^app line 3$/app line 3 (PR H)/' "PR H: proof 2")
sleep 30; state "$H"
gh pr merge "$H" -R "$R" --squash 2>&1 | tail -2 || true            # expect: refused (required check)
gh pr merge "$H" -R "$R" --auto --squash 2>&1 | tail -1; state "$H"  # expect: auto-merge enabled, still open
echo "nod at $(ts)"; bun "$here/sign.ts" --clone "$SB" --key "$S/keys/alice" --reviewer FreshlyBrewedCode --post "$H" >/dev/null
until [ "$(gh pr view "$H" -R "$R" --json state --jq .state)" = MERGED ]; do sleep 3; done; echo "merged at $(ts)"; state "$H"

echo "== 2b: --admin on a red PR (bypass list empty)"
A=$(newpr spike/a app/hello.txt 's/^app line 4$/app line 4 (PR admin)/' "PR admin: --admin test")
sleep 30; gh pr merge "$A" -R "$R" --squash --admin 2>&1 | tail -2 || true; state "$A"

echo "== 3: commit-status forgery with the user token (expect: still blocked, wrong source)"
C=$(newpr spike/c core/engine.txt 's/^core line 2$/core line 2 (PR status-forge)/' "PR status-forge")
sleep 30; sha=$(gh pr view "$C" -R "$R" --json headRefOid --jq .headRefOid)
gh api -X POST "repos/$R/statuses/$sha" -f state=success -f context=nod --jq .state
gh pr merge "$C" -R "$R" --squash 2>&1 | tail -2 || true; state "$C"

echo "== 4: check-run forgery from a branch workflow, with auto-merge armed (the real question)"
F=$(newpr spike/f core/engine.txt 's/^core line 3$/core line 3 (PR check-forge)/' "PR check-forge")
sleep 30; gh pr merge "$F" -R "$R" --auto --squash 2>&1 | tail -1
sha=$(gh pr view "$F" -R "$R" --json headRefOid --jq .headRefOid)
git -C "$SB" checkout -q attack/forge && echo "$sha" > "$SB/forge-target.txt"
git -C "$SB" commit -qam "ci: retarget" && echo "forge push at $(ts)" && git -C "$SB" push -q origin attack/forge
for i in $(seq 1 40); do s=$(gh pr view "$F" -R "$R" --json state --jq .state); [ "$s" = MERGED ] && break; sleep 3; done
echo "after forge: $(state "$F") at $(ts)"

echo "== 5: can the owner token edit the ruleset? (read only here; do not delete)"
gh api "repos/$R/rulesets" --jq '.[]|{id,name}' -c

#!/usr/bin/env bash
# Follow-up to prove-ruleset.sh: the full server messages (REST merge) for a missing check,
# a red check, a forged commit status, and --admin. NOT production code.
set -uo pipefail
R=FreshlyBrewedCode/nod-sandbox
here="$(cd "$(dirname "$0")" && pwd)"; SB="$(dirname "$here")/sandbox"
git -C "$SB" fetch -q origin
git -C "$SB" checkout -q -B spike/m origin/main
sed -i 's/^app line 5$/app line 5 (PR missing)/' "$SB/app/hello.txt"
git -C "$SB" commit -qam "PR missing: merge before the check exists"
git -C "$SB" push -q -f -u origin spike/m 2>/dev/null
N=$(gh pr create -R $R --head spike/m --base main --title "PR missing: merge before the check exists" --body "spike: prove-ruleset" | grep -o '[0-9]*$')
echo "PR $N at $(date -u +%T)"
echo "-- REST merge at once:"; gh api -X PUT repos/$R/pulls/$N/merge -f merge_method=squash 2>&1; echo
gh pr view $N -R $R --json statusCheckRollup --jq '[.statusCheckRollup[]|{name,status,conclusion}]'
sleep 40
gh pr view $N -R $R --json statusCheckRollup --jq '[.statusCheckRollup[]|{name,status,conclusion}]'
echo "-- REST merge while red:"; gh api -X PUT repos/$R/pulls/$N/merge -f merge_method=squash 2>&1; echo
sha=$(gh pr view $N -R $R --json headRefOid --jq .headRefOid)
echo "-- forged commit status:"; gh api -X POST repos/$R/statuses/$sha -f state=success -f context=nod --jq '{state,context,creator:.creator.login}'
sleep 5
gh pr view $N -R $R --json mergeStateStatus,statusCheckRollup --jq '{m:.mergeStateStatus,r:[.statusCheckRollup[]|{name,context,state,conclusion}]}'
echo "-- REST merge with the forged status:"; gh api -X PUT repos/$R/pulls/$N/merge -f merge_method=squash 2>&1; echo
echo "-- gh pr merge --admin:"; gh pr merge $N -R $R --squash --admin 2>&1; echo "exit $?"
echo "N=$N"

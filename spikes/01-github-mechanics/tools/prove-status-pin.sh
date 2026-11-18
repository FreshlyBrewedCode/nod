#!/usr/bin/env bash
# Is a commit status named `nod` ignored because the ruleset pins the check to GitHub Actions,
# or only because the real (failing) check run outranks it? Disables the nod workflow briefly
# so that no check run exists, forges the status, tries to merge. NOT production code.
set -uo pipefail
R=FreshlyBrewedCode/nod-sandbox
here="$(cd "$(dirname "$0")" && pwd)"; SB="$(dirname "$here")/sandbox"
gh workflow disable nod.yml -R $R && echo "nod workflow disabled"
git -C "$SB" fetch -q origin
git -C "$SB" checkout -q -B spike/s origin/main
sed -i 's/^app line 6$/app line 6 (PR status-only)/' "$SB/app/hello.txt"
git -C "$SB" commit -qam "PR status-only: forged status, no check run"
git -C "$SB" push -q -f -u origin spike/s 2>/dev/null
N=$(gh pr create -R $R --head spike/s --base main --title "PR status-only: forged status, no check run" --body "spike: prove-ruleset" | grep -o '[0-9]*$')
sleep 20
sha=$(gh pr view $N -R $R --json headRefOid --jq .headRefOid)
gh api -X POST repos/$R/statuses/$sha -f state=success -f context=nod --jq '{state,context,creator:.creator.login}'
sleep 5
gh pr view $N -R $R --json mergeStateStatus,statusCheckRollup --jq '{m:.mergeStateStatus,r:[.statusCheckRollup[]|{name,context,state,conclusion}]}'
echo "-- REST merge, status only:"; gh api -X PUT repos/$R/pulls/$N/merge -f merge_method=squash 2>&1; echo
gh workflow enable nod.yml -R $R && echo "nod workflow enabled"
echo "N=$N"

#!/usr/bin/env bash
# local experiments: what does git patch-id --stable hash?
set -euo pipefail
D="$1"; rm -rf "$D"; mkdir -p "$D"; cd "$D"
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1
git init -q -b main .
git config user.email t@example.invalid; git config user.name t
seq 1 30 > a.txt; printf '\x00\x01\x02' > b.bin
git add .; git commit -qm base
pid() { git diff --no-color --no-ext-diff "$@" | git patch-id --stable | cut -d' ' -f1; }
git checkout -qb feat
sed -i 's/^15$/15 changed/' a.txt; git commit -qam feat
echo "plain:            $(pid main feat)"
echo "U0:               $(pid -U0 main feat)"
echo "U10:              $(pid -U10 main feat)"
echo "full-index:       $(pid --full-index main feat)"
echo "binary:           $(pid --binary main feat)"
# base moves: change a context line (13) -> rebase cleanly
git checkout -q main; sed -i 's/^13$/13 base/' a.txt; git commit -qam basectx
git checkout -q feat; git rebase -q main
echo "after ctx rebase: $(pid main feat)  (context line 13 changed on base)"
# base moves far away
git checkout -q main; echo far >> a.txt; git commit -qam far
git checkout -q feat; git rebase -q main
echo "after far rebase: $(pid main feat)"
# binary content change only
git checkout -q main; git checkout -qb bin1; printf '\x00\x09' > b.bin; git commit -qam bin1
git checkout -q main; git checkout -qb bin2; printf '\x00\x07\x07' > b.bin; git commit -qam bin2
echo "bin1 plain:  $(pid main bin1)   bin2 plain:  $(pid main bin2)"
echo "bin1 binary: $(pid --binary main bin1)   bin2 binary: $(pid --binary main bin2)"
echo "bin1 full-index: $(pid --full-index main bin1)   bin2 full-index: $(pid --full-index main bin2)"
# rename
git checkout -q main; git checkout -qb ren; git mv a.txt c.txt; git commit -qm ren
echo "rename -M:   $(pid -M main ren)   --no-renames: $(pid --no-renames main ren)"
# mode change only
git checkout -q main; git checkout -qb mode; chmod +x a.txt; git commit -qam mode
echo "mode change: '$(pid main mode)'"
# empty file add
git checkout -q main; git checkout -qb empty; touch e.txt; git add e.txt; git commit -qm empty
echo "empty add:   '$(pid main empty)'"

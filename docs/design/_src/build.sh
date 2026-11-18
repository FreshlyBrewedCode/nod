#!/usr/bin/env bash
# Inlines _src/data.js into each direction's source so the output HTML is self-contained.
set -e; cd "$(dirname "$0")"
for d in a-triage b-briefing c-flow; do
  [ -f "$d.html" ] || continue
  awk -v f=data.js '/<!--DATA-->/{print "<script>"; while((getline l < f)>0) print l; close(f); print "</script>"; next} {print}' "$d.html" > "../$d/index.html"
done

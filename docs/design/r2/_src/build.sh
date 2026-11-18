#!/usr/bin/env bash
# Inlines round-1 shared data + round-2 additions into app.html -> ../app/index.html
set -e; cd "$(dirname "$0")"
awk '/<!--DATA-->/{print "<script>"; while((getline l < "../../_src/data.js")>0) print l; while((getline l < "data2.js")>0) print l; print "</script>"; next} {print}' app.html > ../app/index.html

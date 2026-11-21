#!/usr/bin/env bash
# Inlines the two fonts (latin subset, as the web app self-hosts them) into app.html -> ../app/index.html
# usage: build.sh   (FONTS=<dir holding @fontsource-variable> overrides ../../../../node_modules)
set -e; cd "$(dirname "$0")"
F=${FONTS:-../../../../node_modules}/@fontsource-variable
face() { printf '@font-face{font-family:"%s";font-style:normal;font-weight:100 900;font-display:swap;src:url(data:font/woff2;base64,%s) format("woff2-variations")}\n' "$1" "$(base64 -w0 "$2")"; }
{ face "Inter Variable" "$(ls "$F"/inter*/files/inter-latin-wght-normal.woff2 | head -1)"; face "JetBrains Mono Variable" "$(ls "$F"/jetbrains-mono*/files/jetbrains-mono-latin-wght-normal.woff2 | head -1)"; } > fonts.css.tmp
awk 'FNR==NR{f=f $0 "\n"; next} /\/\*FONTS\*\//{printf "%s", f; next} {print}' fonts.css.tmp app.html > ../app/index.html
rm fonts.css.tmp

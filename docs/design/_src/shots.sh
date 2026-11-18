#!/usr/bin/env bash
# usage: shots.sh <dir> <prefix> <height> name=hash ...   (starts a short-lived local server, stops it on exit)
cd "$(dirname "$0")/.."; d=$1; p=$2; h=$3; shift 3
python3 -m http.server 8791 --bind 127.0.0.1 >/dev/null 2>&1 & srv=$!; trap 'kill $srv' EXIT; sleep 0.6
for s in "$@"; do name=${s%%=*}; hash=${s#*=}; q=""; [[ $hash == *\?* ]] && { q="?${hash#*\?}"; hash=${hash%%\?*}; }
  playwright-cli -s=mock run-code "async page => { await page.setViewportSize({width:1440,height:$h}); await page.goto('about:blank'); await page.goto('http://127.0.0.1:8791/$d/index.html$q#$hash'); await page.evaluate(() => document.fonts.ready); await page.waitForTimeout(300); const full = await page.evaluate(() => getComputedStyle(document.body).overflowY !== 'hidden'); await page.screenshot({path:'screenshots/$p-$name.png', fullPage: full}); }" | grep -i error
  echo "screenshots/$p-$name.png"
done

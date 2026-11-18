#!/usr/bin/env bash
# usage: shots.sh <height> name=hash ...   (short-lived local server, stopped on exit)
cd "$(dirname "$0")/.."; h=$1; shift
python3 -m http.server 8792 --bind 127.0.0.1 >/dev/null 2>&1 & srv=$!; trap 'kill $srv' EXIT; sleep 0.6
for s in "$@"; do name=${s%%=*}; hash=${s#*=}
  playwright-cli -s=mock run-code "async page => { await page.setViewportSize({width:1440,height:$h}); await page.goto('about:blank'); await page.goto('http://127.0.0.1:8792/app/index.html?v=' + Date.now() + '#$hash'); await page.evaluate(() => document.fonts.ready); await page.waitForTimeout(300); const full = await page.evaluate(() => document.documentElement.scrollHeight > innerHeight + 8); await page.screenshot({path:'screenshots/$name.png', fullPage: full}); }" | grep -iE "error" 
  echo "screenshots/$name.png"
done

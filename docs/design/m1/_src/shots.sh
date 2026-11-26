#!/usr/bin/env bash
# usage: shots.sh [state ...]   390x844 at device scale factor 2, then per direction the whole list (x-list-full) and one overview.
# Needs CHROMIUM=<path to a Chromium binary> (on NixOS: the nix-store one). Short-lived local server, stopped on exit.
set -e; cd "$(dirname "$0")/.."
states=${*:-$(for d in a b c; do for s in list select detail detail-2 unlock signed; do echo $d-$s; done; done) c-detail-3}
cfg=$(mktemp --suffix=.json)
echo "{\"browser\":{\"browserName\":\"chromium\",\"launchOptions\":{\"executablePath\":\"$CHROMIUM\"},\"contextOptions\":{\"viewport\":{\"width\":390,\"height\":844},\"deviceScaleFactor\":2,\"isMobile\":true,\"hasTouch\":true}}}" > "$cfg"
python3 -m http.server 8794 --bind 127.0.0.1 >/dev/null 2>&1 & srv=$!
pw() { env -u LD_LIBRARY_PATH playwright-cli -s=m1 "$@"; }
trap 'kill $srv; pw close >/dev/null 2>&1; rm -f "$cfg"' EXIT; sleep 0.6
pw open --config="$cfg" about:blank >/dev/null
shot() { pw run-code "async page => { await page.setViewportSize({width:$1,height:$2}); await page.goto('about:blank'); await page.goto('http://127.0.0.1:8794/$3'); await page.evaluate(() => document.fonts.ready); await page.waitForTimeout(250);
  if ($5) { await page.setViewportSize({width:$1,height:await page.evaluate(() => document.documentElement.scrollHeight)}); await page.waitForTimeout(150); }
  await page.screenshot({path:'screenshots/$4.png'}); }" | grep -E "^(### )?Error" || true; echo "screenshots/$4.png"; }
for s in $states; do shot 390 844 "app/index.html?v=$RANDOM#$s" "$s" false; done
for d in a b c; do shot 390 844 "app/index.html?v=$RANDOM#$d-list" "$d-list-full" true; shot 2110 960 "_src/overview.html?v=$RANDOM#$d" "$d-overview" false; done

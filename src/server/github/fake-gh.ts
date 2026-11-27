/**
 * A stand-in `gh` for tests: a shell script in a temp folder that answers
 * `gh auth token --hostname <host>` as the real one does. Never the real
 * `gh`, never a real login.
 */

import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { tempDir } from "../../kit/test-support.ts";

/**
 * A `gh` that is logged in when `$GH_CONFIG_DIR/hosts.yml` names the host,
 * or through `GH_TOKEN`, as the real one is; otherwise it says what gh says.
 */
export const FAKE_GH = `#!/bin/sh
[ "$1 $2 $3" = "auth token --hostname" ] || { echo "unexpected: $*" >&2; exit 2; }
if [ -n "$GH_TOKEN" ]; then echo "$GH_TOKEN"; exit 0; fi
# Shell builtins only: the PATH of a test may hold nothing else.
if [ -f "$GH_CONFIG_DIR/hosts.yml" ]; then
  while IFS= read -r line; do
    if [ "$line" = "$4:" ]; then echo "gho_fakeTokenForTests"; exit 0; fi
  done < "$GH_CONFIG_DIR/hosts.yml"
fi
echo "no oauth token found for $4" >&2
exit 1
`;

/** A folder with the stand-in `gh` in `bin/`, and a gh config folder that has a login for `hosts`. */
export async function makeFakeGh(hosts: ReadonlyArray<string> = []) {
  const tmp = await tempDir();
  const bin = join(tmp.dir, "bin");
  const config = join(tmp.dir, "gh");
  mkdirSync(bin);
  mkdirSync(config);
  writeFileSync(join(bin, "gh"), FAKE_GH);
  chmodSync(join(bin, "gh"), 0o755);
  writeFileSync(join(config, "hosts.yml"), hosts.map((h) => `${h}:\n`).join(""));
  return { dir: tmp.dir, bin, gh: join(bin, "gh"), config, cleanup: tmp.cleanup };
}

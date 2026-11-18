// Spike signer: builds a nod payload for one or more PRs, signs it with ssh-keygen -Y sign, prints the comment body.
// NOT production code. Usage:
//   bun sign.ts --clone <local clone> --key <private key> --reviewer <principal> [--repo owner/name]
//               [--level review] [--verdict approve] [--post] <pr> [<pr> ...]
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonical, git, patchId, renderComment, type Entry } from "../sandbox/.nod/lib.ts";

const args = process.argv.slice(2);
const opt = (k: string, d?: string) => { const i = args.indexOf(`--${k}`); if (i < 0) return d; const v = args[i + 1]; args.splice(i, 2); return v; };
const flag = (k: string) => { const i = args.indexOf(`--${k}`); if (i < 0) return false; args.splice(i, 1); return true; };
const clone = opt("clone")!, key = opt("key")!, reviewer = opt("reviewer")!;
const repo = opt("repo", "FreshlyBrewedCode/nod-sandbox")!, level = opt("level", "review")!, verdict = opt("verdict", "approve")!;
const post = flag("post");
// attack helpers: claim another repo in the payload, sign under another namespace
const payloadRepo = opt("payload-repo", repo)!, ns = opt("namespace", "nod")!;
const prs = args.map(Number);

const gh = (a: string[]) => { const r = spawnSync("gh", a, { encoding: "utf8" }); if (r.status !== 0) throw new Error(r.stderr); return r.stdout; };
const entries: Entry[] = [];
for (const n of prs) {
  const pr = JSON.parse(gh(["api", `repos/${repo}/pulls/${n}`]));
  git(clone, ["fetch", "--no-tags", "--quiet", "origin", `+refs/heads/${pr.base.ref}:refs/nod/base`, pr.head.sha]);
  const { patchId: pid } = patchId(clone, "refs/nod/base", pr.head.sha);
  entries.push({ pr: n, base: pr.base.ref, head_sha: pr.head.sha, patch_id: pid });
}
const line = canonical({ v: 1, repo: payloadRepo, entries, verdict: verdict as "approve", level, reviewer, signed_at: new Date().toISOString() });
const dir = mkdtempSync(join(tmpdir(), "nodsign-"));
writeFileSync(join(dir, "payload"), line);
const s = spawnSync("ssh-keygen", ["-Y", "sign", "-q", "-f", key, "-n", ns, join(dir, "payload")], { encoding: "utf8" });
if (s.status !== 0) throw new Error(s.stderr);
const sig = readFileSync(join(dir, "payload.sig"), "utf8");
const human = `**nod** · ${verdict} · ${level} · by \`${reviewer}\` · ${entries.map((e) => `#${e.pr}`).join(" ")}`;
const body = renderComment(line, sig, human);
if (post) {
  writeFileSync(join(dir, "body.md"), body);
  for (const n of prs) {
    const url = gh(["pr", "comment", String(n), "--repo", repo, "--body-file", join(dir, "body.md")]).trim();
    console.error(`posted on #${n}: ${url}  at ${new Date().toISOString()}`);
  }
}
process.stdout.write(body);

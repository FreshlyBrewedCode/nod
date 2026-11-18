// Spike helper: show the `nod` check runs on a PR head and what GitHub's rollup says. NOT production code.
// Usage: bun checks.ts <pr> [--wait-after <ISO time>] [--timeout <s>]
import { spawnSync } from "node:child_process";
const repo = "FreshlyBrewedCode/nod-sandbox";
const args = process.argv.slice(2);
const pr = Number(args[0]);
const wi = args.indexOf("--wait-after"); const after = wi >= 0 ? Date.parse(args[wi + 1]) : 0;
const ti = args.indexOf("--timeout"); const timeout = (ti >= 0 ? Number(args[ti + 1]) : 180) * 1000;
const gh = (a: string[]) => JSON.parse(spawnSync("gh", a, { encoding: "utf8" }).stdout);
const t0 = Date.now();
for (;;) {
  const p = gh(["api", `repos/${repo}/pulls/${pr}`]);
  const runs = gh(["api", `repos/${repo}/commits/${p.head.sha}/check-runs?check_name=nod&filter=all&per_page=100`]).check_runs;
  const fresh = runs.filter((r: any) => r.completed_at && Date.parse(r.completed_at) > after);
  if (!after || fresh.length || Date.now() - t0 > timeout) {
    const q = `query{repository(owner:"FreshlyBrewedCode",name:"nod-sandbox"){pullRequest(number:${pr}){mergeStateStatus mergeable commits(last:1){nodes{commit{statusCheckRollup{state contexts(first:20){nodes{__typename ...on CheckRun{name conclusion databaseId} ...on StatusContext{context state}}}}}}}}}}`;
    const g = gh(["api", "graphql", "-f", `query=${q}`]).data.repository.pullRequest;
    console.log(JSON.stringify({
      pr, head: p.head.sha, base: p.base.ref, merge_state: g.mergeStateStatus,
      rollup: g.commits.nodes[0].commit.statusCheckRollup,
      nod_runs: runs.map((r: any) => ({ id: r.id, conclusion: r.conclusion, app: r.app.slug, suite: r.check_suite.id, completed_at: r.completed_at, title: r.output.title })),
      latency_note: after ? `first fresh nod check ${fresh.length ? (Date.parse(fresh.at(-1).completed_at) - after) / 1000 + "s after reference time" : "none within timeout"}` : undefined,
    }, null, 1));
    break;
  }
  await Bun.sleep(3000);
}

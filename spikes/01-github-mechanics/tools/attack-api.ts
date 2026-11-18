// Spike: things an agent can try with the human's gh token (scopes: repo, read:org, gist, project; no `workflow`).
// NOT production code. Usage: bun attack-api.ts <contents|deploy> [args]
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
const repo = "FreshlyBrewedCode/nod-sandbox";
const token = spawnSync("gh", ["auth", "token"], { encoding: "utf8" }).stdout.trim();
async function api(method: string, path: string, body?: unknown) {
  const r = await fetch(`https://api.github.com/repos/${repo}${path}`, {
    method, body: body ? JSON.stringify(body) : undefined,
    headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28" },
  });
  const t = await r.text();
  console.log(`${method} ${path} -> ${r.status} ${t.slice(0, 300)}`);
  return { status: r.status, json: (() => { try { return JSON.parse(t); } catch { return null; } })() };
}
const [cmd, ...rest] = process.argv.slice(2);
if (cmd === "contents") {
  // create a branch and try to add a workflow file through the contents API
  const main = (await api("GET", "/branches/main")).json.commit.sha;
  await api("POST", "/git/refs", { ref: "refs/heads/attack/contents-api", sha: main });
  const content = Buffer.from(readFileSync(rest[0])).toString("base64");
  await api("PUT", "/contents/.github/workflows/forge2.yml", { message: "ci: via contents API", content, branch: "attack/contents-api" });
} else if (cmd === "deploy") {
  // try to create a successful deployment in environment `nod` for a ref with the user's token
  const [ref, env = "nod"] = rest;
  const d = await api("POST", "/deployments", { ref, environment: env, auto_merge: false, required_contexts: [], description: "forged" });
  if (d.json?.id) await api("POST", `/deployments/${d.json.id}/statuses`, { state: "success", environment: env });
} else if (cmd === "raw") {
  const [method, path, body] = rest;
  await api(method, path, body ? JSON.parse(body) : undefined);
}

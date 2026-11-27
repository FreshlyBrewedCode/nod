/**
 * The whole flow through the public surface, the way `.nod/verify.ts` and
 * the signer will use it: a real repo, real keys, a batch nod posted as a
 * comment, verified, evaluated against the policy, summarised.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  buildSummary,
  changedFiles,
  checkConclusion,
  checkTitle,
  declared,
  decodeSummary,
  defaultRules,
  definePolicy,
  diffSize,
  encodeSummary,
  enrolledLogins,
  evaluateApprovals,
  evaluateNods,
  evaluatePolicy,
  gitFileReader,
  nodHumanLine,
  parseNodComments,
  patchId,
  paths,
  renderNodComment,
  renderSticky,
  serializePayload,
  verifyNodBlocks,
  type NodPayload,
  type PullRequestReview,
  type PullRequestState,
} from "./index.ts";
import { makeKey, sshSign, tempDir, tempRepo } from "./test-support.ts";

let keys: Awaited<ReturnType<typeof tempDir>>;
let repo: Awaited<ReturnType<typeof tempRepo>>;
let allowedSignersPath = "";
let alice = { privateKey: "", publicKey: "" };
let bob = { privateKey: "", publicKey: "" };
const heads: Record<number, string> = {};

beforeAll(async () => {
  keys = await tempDir();
  alice = await makeKey(keys.dir, "alice");
  bob = await makeKey(keys.dir, "bob");
  repo = await tempRepo();
  await repo.write(".nod/allowed_signers", `alice ${alice.publicKey}\nbob ${bob.publicKey}\n`);
  await repo.write("app/a.ts", "export const a = 1;\n");
  await repo.write("core/engine.ts", "export const engine = 1;\n");
  await repo.commit("base");
  allowedSignersPath = join(keys.dir, "allowed_signers");
  await writeFile(
    allowedSignersPath,
    (await gitFileReader(repo.dir, "main")(".nod/allowed_signers"))!,
  );
  // PR #1: an app change; PR #2: a core change
  for (const [n, path] of [
    [1, "app/a.ts"],
    [2, "core/engine.ts"],
  ] as const) {
    await repo.git("checkout", "-q", "-b", `pr-${n}`, "main");
    await repo.write(path, `export const changed = ${n};\n`);
    heads[n] = await repo.commit(`pr ${n}`);
  }
  await repo.git("checkout", "-q", "main");
});

afterAll(async () => {
  await keys.cleanup();
  await repo.cleanup();
});

const policy = definePolicy({
  classifiers: [
    paths({ "core/**": { tag: "core", risk: 3 }, "app/**": { tag: "app", risk: 1 } }),
    diffSize(),
    declared(),
  ],
  rules: defaultRules(),
});

async function prState(n: number): Promise<PullRequestState> {
  const range = { repoDir: repo.dir, baseTip: "main", head: heads[n]! };
  return {
    repo: "acme/widgets",
    number: n,
    author: "alice",
    base: "main",
    head_sha: heads[n]!,
    patch_id: await patchId(range),
  };
}

/** What `.nod/verify.ts` does for one PR, minus the GitHub calls. */
async function verify(n: number, commentBodies: string[], reviews: PullRequestReview[] = []) {
  const pr = await prState(n);
  const files = await changedFiles({ repoDir: repo.dir, baseTip: "main", head: pr.head_sha });
  const result = await evaluatePolicy(policy, {
    pr: { ...pr, title: `PR ${n}`, body: "", labels: [] },
    files,
    readBaseFile: gitFileReader(repo.dir, "main"),
  });
  const { verified, rejected } = await verifyNodBlocks(commentBodies.flatMap(parseNodComments), {
    allowedSignersPath,
  });
  const approvals = await evaluateApprovals({
    pr,
    reviews,
    canApprove: async (login) => ["bob", "carol"].includes(login),
  });
  const nods = evaluateNods({ pr, requirement: result.requirement, verified, rejected, approvals });
  const signers = enrolledLogins(
    (await gitFileReader(repo.dir, "main")(".nod/allowed_signers")) ?? "",
  );
  return buildSummary({ pr, policy: result, nods, signers, now: new Date("2026-11-18T19:00:00Z") });
}

/** What the signer does: one payload for several PRs, one signature, one comment body. */
async function sign(reviewer: string, privateKey: string, prs: number[]): Promise<string> {
  const entries = [];
  for (const n of prs) {
    const s = await prState(n);
    entries.push({ pr: n, base: s.base, head_sha: s.head_sha, patch_id: s.patch_id });
  }
  const payload: NodPayload = {
    v: 1,
    repo: "acme/widgets",
    entries,
    verdict: "approve",
    level: "review",
    reviewer,
    signed_at: "2026-11-18T18:53:37.944Z",
  };
  const line = serializePayload(payload);
  return renderNodComment(line, await sshSign(privateKey, line), nodHumanLine(payload));
}

test("no nods: PR #1 waits for a self nod, PR #2 for a peer", async () => {
  expect(checkTitle(await verify(1, ["no nod here"]))).toBe(
    "waiting for a self nod or an approval",
  );
  expect(checkTitle(await verify(2, []))).toBe("waiting for a peer approval or nod");
});

test("alice's batch nod covers both PRs, as self; PR #2 still needs a peer", async () => {
  const body = await sign("alice", alice.privateKey, [1, 2]);
  const one = await verify(1, [body]);
  expect(checkConclusion(one)).toBe("success");
  expect(checkTitle(one)).toBe("nodded by alice (self)");
  const two = await verify(2, [body]);
  expect(checkTitle(two)).toBe("waiting for a peer approval or nod (have: alice (self))");

  const withBob = await verify(2, [body, await sign("bob", bob.privateKey, [2])]);
  expect(checkTitle(withBob)).toBe("nodded by alice (self), bob (peer)");
  expect(withBob.signers).toEqual(["alice", "bob"]);

  // the summary survives the trip through the check run
  expect(decodeSummary(encodeSummary(withBob))).toEqual(withBob);
  expect(renderSticky(withBob, { uiBase: "https://ui.example.test" })).toContain(
    "https://ui.example.test/#/pr/acme/widgets/2",
  );
});

test("carol approves #2 on GitHub: the peer slot is filled by her approval", async () => {
  const head = heads[2]!;
  const review = (state: string, commit_id = head): PullRequestReview => ({
    reviewer: "carol",
    reviewerType: "User",
    state,
    commit_id,
    submitted_at: "2026-11-26T09:00:00Z",
  });
  const s = await verify(2, [], [review("APPROVED")]);
  expect(checkConclusion(s)).toBe("success");
  expect(checkTitle(s)).toBe("approved by carol");
  expect(s.filled).toEqual([{ slot: "peer", reviewer: "carol", by: "approval" }]);
  // an approval of an earlier commit does not count
  const stale = await verify(2, [], [review("APPROVED", heads[1]!)]);
  expect(stale.satisfied).toBe(false);
  expect(stale.approvals[0]!.why_not?.code).toBe("stale");
});

test("a forged nod (bob's key, claiming alice) is listed and does not count", async () => {
  const forged = (await sign("alice", bob.privateKey, [2])).replace(/\n/g, "\r\n");
  const s = await verify(2, [forged]);
  expect(s.satisfied).toBe(false);
  expect(s.nods).toHaveLength(1);
  expect(s.nods[0]).toMatchObject({
    reviewer: "alice",
    counts: false,
    why_not: { code: "signature" },
  });
});

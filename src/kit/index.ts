/**
 * `@frebreco/nod/kit`: the pure helpers a repo's own `.nod/verify.ts` and
 * `.nod/policy.ts` import, also reused by `nod serve`.
 *
 * - the nod format: {@link serializePayload}, {@link renderNodComment}, {@link parseNodComments}
 * - signatures via `ssh-keygen`: {@link verifyNodBlocks}, {@link enrolledLogins}
 * - the diff via `git`: {@link patchId}, {@link changedFiles}
 * - which nods count: {@link evaluateNods}
 * - classifiers and the policy: {@link paths}, {@link diffSize}, {@link dependencies},
 *   {@link declared}, {@link definePolicy}, {@link defaultRules}, {@link evaluatePolicy}
 * - requirements: {@link none}, {@link self}, {@link peer}, {@link named}, {@link strictest}
 * - output: {@link buildSummary}, {@link encodeSummary}, {@link checkTitle}, {@link renderSticky}
 * - GitHub REST: {@link getPullRequest}, {@link createCheckRun}, {@link upsertStickyComment}
 * - GitHub hosts (github.com, GHE.com, GitHub Enterprise Server): {@link githubHost},
 *   {@link parseRemote}, {@link fetchWithToken}
 *
 * Zero runtime dependencies. The crypto is OpenSSH's, the diff is git's;
 * both are spawned with argument arrays, never through a shell.
 */

/** Version of the kit's API surface. */
export const KIT_VERSION = 1;

export * from "./classifiers/index.ts";
export * from "./evaluate.ts";
export * from "./github.ts";
export * from "./host.ts";
export * from "./nod.ts";
export * from "./patch-id.ts";
export * from "./policy.ts";
export * from "./requirement.ts";
export * from "./sshsig.ts";
export * from "./sticky.ts";
export * from "./summary.ts";

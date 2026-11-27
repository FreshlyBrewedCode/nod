/**
 * The `inbox` scenario of `nod serve --fake`: the fake team's repo before
 * anyone set nod up (no `.nod/`, no workflow, no key). The PRs are built the
 * way GraphQL returns them and go through the real path: the built-in
 * classification (`github/local.ts`), `github/map.ts`, then `view.ts`.
 *
 * Mara (the viewer) is asked to review two teammates' PRs, one of them
 * through her team `tallyho/core`; two of her own are stuck (changes
 * requested, a conflict); the rest waits on someone else or is quiet.
 * Fictional people and repo, as in `fake-data.ts`.
 */

import { classifyLocally } from "./github/local";
import { mapPr } from "./github/map";
import type { RawContext, RawPr } from "./github/queries";
import { FAKE_ME, FAKE_PEOPLE, fakeHex, prUrl } from "./fake-data";
import type { PrFacts } from "./view";

const MIN = 60_000;
const { mara, jonas, ines } = FAKE_PEOPLE;

/** The team whose review requests reach Mara (GitHub's search says so; the PR only names the team). */
export const INBOX_TEAM = "tallyho/core";

interface InboxSeed {
  readonly n: number;
  readonly title: string;
  readonly by: string;
  readonly body: string;
  readonly files: ReadonlyArray<readonly [string, number, number]>;
  /** Opened, minutes ago. */
  readonly opened: number;
  readonly state?: "open" | "draft" | "merged";
  /** Merged, minutes ago. */
  readonly merged?: number;
  /** `fail` fails `e2e`, `run` keeps it running. */
  readonly checks?: "pass" | "run" | "fail";
  readonly conflict?: boolean;
  /** Logins and teams (`org/team`) asked to review. */
  readonly requested?: ReadonlyArray<string>;
  /** Mara is asked through her team (what GitHub's `review-requested:@me` search finds). */
  readonly viaTeam?: boolean;
  /** Latest deciding reviews: [login, state, minutes ago]. */
  readonly reviews?: ReadonlyArray<readonly [string, "APPROVED" | "CHANGES_REQUESTED", number]>;
}

const brief = (what: string, why: string, risk: string, verified: string, agent = "Claude Code") =>
  [
    `**What** ${what}`,
    "",
    `**Why** ${why}`,
    "",
    `**Risk:** ${risk}`,
    "",
    `**Verified** ${verified}`,
    "",
    `_Opened by ${agent} (agent)._`,
  ].join("\n");

export const INBOX_SEEDS: ReadonlyArray<InboxSeed> = [
  {
    n: 512,
    title: "billing: prorate plan changes mid-cycle",
    by: jonas.login,
    body: brief(
      "Plan changes in the middle of a cycle are charged by the day.",
      "Customers who upgrade late in the month pay for the whole month.",
      "medium. Every invoice goes through the new proration.",
      "Unit tests for upgrade, downgrade and same-day changes.",
    ),
    files: [
      ["src/billing/proration.ts", 180, 40],
      ["src/billing/proration.test.ts", 110, 20],
      ["src/billing/plan.ts", 22, 28],
    ],
    opened: 125,
    requested: [mara.login],
  },
  {
    n: 515,
    title: "ci: cache the bun install between jobs",
    by: ines.login,
    body: brief(
      "The CI workflow restores `node_modules` from a cache keyed by `bun.lock`.",
      "Every job installs from scratch; that is half of the run.",
      "low. A stale cache only slows a run down.",
      "Two runs on this branch, the second one 3 minutes faster.",
    ),
    files: [[".github/workflows/ci.yml", 24, 6]],
    opened: 40,
    requested: [INBOX_TEAM],
    viaTeam: true,
  },
  {
    n: 509,
    title: "search: fix facet counts when items are archived",
    by: mara.login,
    body: brief(
      "Facet counts leave archived items out.",
      "Filtering by a facet showed fewer items than its count said.",
      "low.",
      "A test with archived items in two facets.",
    ),
    files: [
      ["src/search/facets.ts", 64, 12],
      ["src/search/facets.test.ts", 40, 0],
    ],
    opened: 26 * 60,
    reviews: [[jonas.login, "CHANGES_REQUESTED", 95]],
  },
  {
    n: 511,
    title: "inventory: release stock when a reservation times out",
    by: mara.login,
    body: brief(
      "A reservation that times out gives its stock back.",
      "Timed-out carts kept items out of stock until a restart.",
      "medium. Stock numbers change for every timed-out reservation.",
      "A test with a reservation past its timeout.",
    ),
    files: [
      ["src/inventory/reserve.ts", 88, 31],
      ["src/inventory/reserve.test.ts", 52, 4],
    ],
    opened: 6 * 60,
    conflict: true,
    requested: [ines.login],
  },
  {
    n: 513,
    title: "test: run the e2e suite against the staging seed",
    by: jonas.login,
    body: [
      brief(
        "`bun run e2e` seeds a staging-like database before the suite.",
        "The suite passed on an empty database and missed paging bugs.",
        "low.",
        "The suite, twice, locally.",
      ),
      "",
      "FYI: test commands change; `bun run e2e` now needs Docker.",
    ].join("\n"),
    files: [
      ["scripts/e2e.ts", 30, 10],
      ["e2e/seed.ts", 46, 0],
    ],
    opened: 3 * 60,
    checks: "run",
  },
  {
    n: 510,
    title: "core: typed channels for the event bus",
    by: jonas.login,
    body: brief(
      "Every event bus channel gets a type; `emit` and `on` check it.",
      "Untyped payloads broke two consumers last month.",
      "high. Every module that emits an event changes.",
      "Typecheck and the full test suite.",
    ),
    files: [
      ["src/core/bus.ts", 420, 180],
      ["src/core/channels.ts", 360, 0],
      ["src/billing/events.ts", 90, 70],
      ["src/inventory/events.ts", 80, 64],
    ],
    opened: 30 * 60,
  },
  {
    n: 514,
    title: "notifications: batch digest emails per tenant",
    by: ines.login,
    body: brief(
      "Digest emails are sent once per tenant and hour, not per event.",
      "Busy tenants got hundreds of mails a day.",
      "low.",
      "A test with 300 events in one hour.",
    ),
    files: [
      ["src/notifications/digest.ts", 140, 22],
      ["src/notifications/digest.test.ts", 58, 0],
    ],
    opened: 9 * 60,
    requested: [jonas.login],
  },
  {
    n: 507,
    title: "search: index archived items separately",
    by: ines.login,
    body: brief(
      "Archived items go into their own index.",
      "They slowed down every search.",
      "low.",
      "Search timings before and after, on the staging seed.",
    ),
    files: [
      ["src/search/index.ts", 38, 14],
      ["src/search/archive.ts", 26, 0],
    ],
    opened: 20 * 60,
    reviews: [[jonas.login, "APPROVED", 60]],
  },
  {
    n: 516,
    title: "deps: bump vite from 7.1.2 to 7.1.5",
    by: "renovate",
    body: "Bumps vite from 7.1.2 to 7.1.5.",
    files: [
      ["package.json", 1, 1],
      ["bun.lock", 6, 6],
    ],
    opened: 70,
  },
  {
    n: 517,
    title: "docs: explain the offline sync queue",
    by: jonas.login,
    body: brief(
      "A page on how the offline queue replays changes.",
      "Support asked twice this week.",
      "none.",
      "Read it.",
    ),
    files: [["docs/sync.md", 38, 3]],
    opened: 50,
  },
  {
    n: 518,
    title: "export: CSV export for field reports",
    by: mara.login,
    body: brief(
      "Field reports can be downloaded as CSV.",
      "Asked for by three customers.",
      "low.",
      "Not yet: the agent is still writing it.",
    ),
    files: [["src/export/csv.ts", 72, 0]],
    opened: 35,
    state: "draft",
    checks: "run",
  },
  {
    n: 506,
    title: "auth: rotate session tokens on privilege change",
    by: ines.login,
    body: brief(
      "A session gets a new token when its user's role changes.",
      "An old token kept the old role until it expired.",
      "medium.",
      "A test for each role change.",
    ),
    files: [
      ["src/auth/session.ts", 140, 30],
      ["src/auth/session.test.ts", 66, 0],
    ],
    opened: 28 * 60,
    state: "merged",
    merged: 22 * 60,
    reviews: [[mara.login, "APPROVED", 23 * 60]],
  },
];

/** One seed as GraphQL would return it, with times relative to `now`. */
export function inboxRaw(seed: InboxSeed, now: number, repo: string): RawPr {
  const iso = (min: number) => new Date(now - min * MIN).toISOString();
  const state = seed.state ?? "open";
  const checks = seed.checks ?? "pass";
  const names = ["build", "test", "e2e"];
  const contexts: RawContext[] = names.map((name, i) => {
    const failed = checks === "fail" && name === "e2e";
    const running = checks === "run" && name === "e2e";
    return {
      __typename: "CheckRun",
      id: `CR_${seed.n}_${i}`,
      databaseId: seed.n * 10 + i,
      name,
      status: running ? "IN_PROGRESS" : "COMPLETED",
      conclusion: running ? null : failed ? "FAILURE" : "SUCCESS",
      startedAt: iso(Math.min(seed.opened, 30) + 2),
      completedAt: running ? null : iso(Math.min(seed.opened, 30)),
      title: null,
      checkSuite: {
        app: { slug: "github-actions" },
        workflowRun: { workflow: { resourcePath: `/${repo}/actions/workflows/ci.yml` } },
      },
    };
  });
  const added = seed.files.reduce((n, f) => n + f[1], 0);
  const removed = seed.files.reduce((n, f) => n + f[2], 0);
  const head = fakeHex(seed.n.toString(16), "inbox");
  return {
    number: seed.n,
    title: seed.title,
    body: seed.body,
    url: prUrl(repo, seed.n),
    state: state === "merged" ? "MERGED" : "OPEN",
    isDraft: state === "draft",
    merged: state === "merged",
    mergedAt: seed.merged !== undefined ? iso(seed.merged) : null,
    closedAt: seed.merged !== undefined ? iso(seed.merged) : null,
    createdAt: iso(seed.opened),
    updatedAt: iso(Math.min(seed.opened, 20)),
    author: {
      login: seed.by,
      name: Object.values(FAKE_PEOPLE).find((p) => p.login === seed.by)?.name ?? null,
    },
    baseRefName: "main",
    headRefName: `agent/${seed.n}`,
    headRefOid: head,
    baseRef: { target: { oid: fakeHex("ba5e", "inbox") } },
    additions: added,
    deletions: removed,
    changedFiles: seed.files.length,
    autoMergeRequest: null,
    mergeable: state === "merged" ? "UNKNOWN" : seed.conflict ? "CONFLICTING" : "MERGEABLE",
    reviewRequests: {
      nodes: (seed.requested ?? []).map((r) => ({
        requestedReviewer: r.includes("/")
          ? { __typename: "Team", combinedSlug: r }
          : { __typename: "User", login: r },
      })),
    },
    latestOpinionatedReviews: {
      nodes: (seed.reviews ?? []).map(([login, reviewState, min]) => ({
        state: reviewState,
        submittedAt: iso(min),
        author: { login },
      })),
    },
    files: {
      totalCount: seed.files.length,
      nodes: seed.files.map(([path, additions, deletions]) => ({ path, additions, deletions })),
    },
    commits: {
      nodes: [
        {
          commit: {
            oid: head,
            committedDate: iso(seed.opened),
            statusCheckRollup: { state: "SUCCESS", contexts: { nodes: contexts } },
          },
        },
      ],
    },
    comments: { totalCount: 0, nodes: [] },
    reactions: { nodes: [] },
    timelineItems: { nodes: [] },
  };
}

/** The scenario's PRs as `PrFacts`: classified locally, mapped as the GitHub source maps them. */
export async function inboxFacts(now: number, repo: string): Promise<PrFacts[]> {
  const out: PrFacts[] = [];
  for (const seed of INBOX_SEEDS) {
    const raw = inboxRaw(seed, now, repo);
    const local = await classifyLocally({
      repo,
      number: raw.number,
      title: raw.title,
      body: raw.body,
      author: seed.by,
      base: raw.baseRefName,
      headSha: raw.headRefOid,
      files: raw.files!.nodes,
      totalFiles: raw.files!.totalCount,
    });
    const { facts } = mapPr(raw, {
      repo,
      defaultBranch: "main",
      summary: { kind: "none" },
      // Patch-ids are for signing; nothing is signed at the inbox step.
      patchId: null,
      headBranches: new Map(),
      epicTitles: new Map(),
      // No allowed_signers yet: an FYI is for me.
      team: [FAKE_ME],
      me: FAKE_ME,
      local,
      reviewRequested: seed.viaTeam ?? seed.requested?.includes(FAKE_ME) ?? false,
    });
    out.push(facts);
  }
  return out;
}

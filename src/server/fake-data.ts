/**
 * The r3 mockup's data set (`docs/design/_src/data.js` + `r3/_src/data2.js`),
 * ported to `PrFacts`. Fictional team and repo: Mara (the viewer), Jonas and
 * Ines on `tallyho/fieldbook`. Times are minutes before `now` (the server's
 * start), so the chronological buckets look alive whenever it runs.
 *
 * Differences from the mockup, on purpose:
 * - SHAs and patch-ids are 40 hex characters (the mockup's 7 plus a
 *   deterministic tail), so the head check in `sign` works like the real one.
 * - Dependency bumps carry their lockfile in `diff.excluded`.
 */

import { createHash } from "node:crypto";

import type {
  Brief,
  Category,
  FileChange,
  Fyi,
  JourneyEvent,
  Person,
  PrState,
  Reason,
  Risk,
  Signature,
  Slot,
} from "../shared/protocol";
import type { PrFacts } from "./view";

export const FAKE_REPO = "tallyho/fieldbook";

export const FAKE_PEOPLE = {
  mara: { login: "mara-l", name: "Mara Lindqvist" },
  jonas: { login: "jonas-r", name: "Jonas Reuter" },
  ines: { login: "inescal", name: "Ines Calderón" },
} as const satisfies Record<string, Person>;

type Who = keyof typeof FAKE_PEOPLE;

export const FAKE_ME = FAKE_PEOPLE.mara.login;

/** A fake person's first name, by login. */
export function personName(login: string): string {
  const person = Object.values(FAKE_PEOPLE).find((p) => p.login === login);
  return person ? person.name.split(" ")[0]! : login;
}

/** A 40-hex id that starts with the mockup's short one. */
export function fakeHex(prefix: string, salt = ""): string {
  return (
    prefix +
    createHash("sha1")
      .update(prefix + salt)
      .digest("hex")
  ).slice(0, 40);
}

interface SlotSeed {
  readonly role: Slot["role"];
  readonly label: string;
  /** null: a peer slot, anyone but `except`. */
  readonly who: Who | null;
  readonly except?: Who;
  readonly state: Slot["state"];
  /** The nod that fills it (or filled it, when stale): minutes ago, the head it signed, what matches now. */
  readonly nod?: {
    readonly min: number;
    readonly sha: string;
    readonly via: "head_sha" | "patch_id" | null;
  };
}

interface Seed {
  readonly n: number;
  readonly title: string;
  readonly by: Who;
  readonly agent: string;
  readonly topic: string;
  readonly cat: Category;
  readonly state: PrState;
  readonly risk: Risk;
  readonly tags: ReadonlyArray<string>;
  readonly add: number;
  readonly del: number;
  readonly files: number;
  readonly lockfile?: { readonly add: number; readonly del: number };
  /** [passed, total, state] */
  readonly checks: readonly [number, number, "pass" | "run" | "fail"];
  readonly failing?: ReadonlyArray<string>;
  readonly sha: string;
  readonly patch: string;
  /** Opened, minutes ago. */
  readonly opened: number;
  /** Last activity: minutes ago and what happened, from Mara's side. */
  readonly act: readonly [number, string];
  readonly merged?: number;
  readonly reasons: ReadonlyArray<readonly [string, string, string, boolean?]>;
  readonly policy: string;
  readonly req: string;
  readonly slots: ReadonlyArray<SlotSeed>;
  readonly fyi?: {
    readonly reason: string;
    readonly source: Fyi["source"];
    readonly acked: Who[];
    readonly pending: Who[];
  };
  readonly brief: Brief;
  readonly epic?: { readonly number: number; readonly title: string };
  readonly dependsOn?: ReadonlyArray<number>;
  /** New commits after the deep-link request (#485). */
  readonly moved?: { readonly from: string; readonly commits: number; readonly min: number };
  /** The deep-link request on #482. */
  readonly requested?: number;
  readonly fileList?: ReadonlyArray<FileChange>;
}

const BILLING = { number: 431, title: "Billing v2" };
const AUTH = { number: 440, title: "Auth hardening" };
const EVENTS = { number: 450, title: "Typed event bus" };

const H = 60;

export const SEEDS: ReadonlyArray<Seed> = [
  {
    n: 482,
    title: "billing: prorate plan changes mid-cycle",
    by: "jonas",
    agent: "Claude Code",
    topic: "Billing v2",
    cat: "decide",
    state: "open",
    risk: 2,
    tags: ["tier 3"],
    add: 312,
    del: 88,
    files: 9,
    checks: [14, 14, "pass"],
    sha: "9f3c2ab",
    patch: "e41b7c0d",
    opened: 126,
    act: [100, "Jonas’s agent asked you to review"],
    requested: 100,
    reasons: [
      ["module-tier", "modules/billing is tier 3", "needs another human", true],
      ["touches-core", "no files under core/", "no change"],
      ["diff-size", "+312 −88 in 9 files (limit 600)", "no change"],
    ],
    policy: "tier3-module-change",
    req: "Another human (not the prompter)",
    slots: [{ role: "peer", label: "Peer", who: null, except: "jonas", state: "missing" }],
    brief: {
      what: "Adds day-based proration when a tenant switches plan mid-cycle; credit note for downgrades, immediate charge for upgrades.",
      why: "Epic #431 Billing v2. Support currently fixes these invoices by hand (about 12 a week).",
      risk: "Money math. Rounding happens per invoice line; leap-day and DST cycle boundaries are the edge cases.",
      verified:
        '41 new unit tests incl. property test on "credit + charge = price difference"; replayed 300 real plan changes from staging.',
      lookAt: ["modules/billing/proration.ts", "modules/billing/proration.test.ts"],
    },
    epic: BILLING,
    dependsOn: [485],
  },
  {
    n: 485,
    title: "billing: add invoices.currency_code with backfill",
    by: "jonas",
    agent: "Claude Code",
    topic: "Billing v2",
    cat: "decide",
    state: "open",
    risk: 3,
    tags: ["migration", "tier 3"],
    add: 96,
    del: 4,
    files: 5,
    checks: [14, 14, "pass"],
    sha: "8c1f5d0",
    patch: "19d0aa62",
    opened: 192,
    act: [140, "2 new commits"],
    moved: { from: "41aa9e7", commits: 2, min: 140 },
    reasons: [
      [
        "migration",
        "adds db/migrations/0147_invoice_currency.sql",
        "needs prompter + another human",
        true,
      ],
      ["module-tier", "modules/billing is tier 3", "needs another human", true],
      [
        "agent-intent",
        'agent declared: "backfill locks invoices for ~20s"',
        "risk raised to high",
        true,
      ],
    ],
    policy: "schema-migration",
    req: "Prompter self-attest + another human",
    slots: [
      { role: "prompter", label: "Prompter", who: "jonas", state: "missing" },
      { role: "peer", label: "Peer", who: null, except: "jonas", state: "missing" },
    ],
    brief: {
      what: "New nullable column invoices.currency_code, backfilled from tenant default in batches of 5,000 rows.",
      why: "Proration (#482) needs the invoice currency; today it is read from the tenant, which is wrong for old invoices.",
      risk: "Schema migration on a 2.1M row table. Backfill is batched, but the first ALTER takes a short lock.",
      verified:
        "Ran against a staging snapshot: 2m 40s total, longest lock 180 ms. Down migration tested.",
      lookAt: ["db/migrations/0147_invoice_currency.sql", "modules/billing/backfill/currency.ts"],
    },
    epic: BILLING,
    dependsOn: [492],
  },
  {
    n: 476,
    title: "auth: rotate session tokens on privilege change",
    by: "jonas",
    agent: "Claude Code",
    topic: "Auth hardening",
    cat: "decide",
    state: "open",
    risk: 3,
    tags: ["core", "security"],
    add: 148,
    del: 61,
    files: 7,
    checks: [14, 14, "pass"],
    sha: "d2c47fa",
    patch: "3fa9c1e7",
    opened: 340,
    act: [315, "rebased · Jonas’s signature held"],
    reasons: [
      ["touches-core", "3 files under core/auth/", "needs prompter + named owner", true],
      ["owner", "core/auth/** is owned by Mara", "named person: Mara"],
      [
        "llm-risk",
        'LLM check: "changes token invalidation order"',
        "tagged security-sensitive",
        true,
      ],
      ["fyi-rule", "core/auth change", "FYI to the whole team"],
    ],
    policy: "core-change",
    req: "Prompter self-attest + named owner (Mara)",
    slots: [
      {
        role: "prompter",
        label: "Prompter",
        who: "jonas",
        state: "ok",
        nod: { min: 330, sha: "5e0a91c", via: "patch_id" },
      },
      { role: "owner", label: "Owner of core/auth", who: "mara", state: "missing" },
    ],
    fyi: { reason: "policy: core/auth change", source: "policy", acked: ["ines"], pending: [] },
    brief: {
      what: "When a user's role changes, all their sessions get a fresh token and the old ones are revoked within one request.",
      why: "Pen-test finding F-07: a demoted admin kept admin rights until the token expired (up to 12h).",
      risk: "Touches core/auth/session.ts. A bug here logs users out or, worse, keeps old tokens alive.",
      verified:
        "New integration test for demote/promote; manual check on staging with two browsers. No load test.",
      lookAt: ["core/auth/session.ts", "core/auth/revocation.ts", "core/auth/session.int.test.ts"],
    },
    epic: AUTH,
    fileList: [
      file("core/auth/session.ts", 64, 38, "core"),
      file("core/auth/revocation.ts", 41, 12, "core"),
      file("core/auth/session.int.test.ts", 29, 0, "core · test"),
      file("modules/admin/roles/update.ts", 8, 9, "tier 2"),
      file("modules/admin/roles/update.test.ts", 4, 0, "tier 2 · test"),
      file("docs/security/sessions.md", 2, 1, "docs"),
      file("CHANGELOG.md", 0, 1, "docs"),
    ],
  },
  {
    n: 488,
    title: "inventory: release stock when a reservation times out",
    by: "mara",
    agent: "Claude Code",
    topic: "Inventory",
    cat: "decide",
    state: "open",
    risk: 1,
    tags: ["tier 2"],
    add: 121,
    del: 17,
    files: 4,
    checks: [14, 14, "pass"],
    sha: "2b7e440",
    patch: "a07f3d91",
    opened: 72,
    act: [70, "checks turned green"],
    reasons: [
      ["module-tier", "modules/inventory is tier 2", "needs prompter self-attest", true],
      ["pure-module", "pure module update, no core, no schema", "no change"],
    ],
    policy: "tier2-module-change",
    req: "Prompter self-attest",
    slots: [{ role: "prompter", label: "Prompter", who: "mara", state: "missing" }],
    brief: {
      what: "A job releases reserved stock 15 minutes after an abandoned checkout.",
      why: "Issue #455: stock stayed reserved forever when the browser tab was closed.",
      risk: 'Low. Worst case stock is released too early and a checkout fails with "out of stock".',
      verified:
        "Unit tests with a fake clock; ran the job against staging data (released 37 stale reservations).",
      lookAt: ["modules/inventory/jobs/release-reservations.ts"],
    },
  },
  {
    n: 490,
    title: "notifications: batch digest emails per tenant",
    by: "mara",
    agent: "Codex",
    topic: "Notifications",
    cat: "decide",
    state: "open",
    risk: 2,
    tags: ["tier 2"],
    add: 203,
    del: 140,
    files: 8,
    checks: [14, 14, "pass"],
    sha: "77d1c3e",
    patch: "c5521b08",
    opened: 50,
    act: [50, "opened by your agent"],
    reasons: [
      ["module-tier", "modules/notifications is tier 2", "needs prompter self-attest", true],
      ["pure-module", "pure module update, no core, no schema", "no change"],
    ],
    policy: "tier2-module-change",
    req: "Prompter self-attest",
    slots: [{ role: "prompter", label: "Prompter", who: "mara", state: "missing" }],
    brief: {
      what: "Digest mails are built once per tenant instead of once per user; one SMTP connection per batch.",
      why: "Digest run took 40 minutes for the largest tenant and hit the provider rate limit.",
      risk: "Low to medium. A wrong grouping key would send one user's digest to another.",
      verified:
        "Snapshot tests on rendered mails for 3 tenants; dry-run on staging compared recipients 1:1 with the old path.",
      lookAt: ["modules/notifications/digest/build.ts", "modules/notifications/digest/send.ts"],
    },
  },
  {
    n: 491,
    title: "search: fix facet counts when items are archived",
    by: "mara",
    agent: "Claude Code",
    topic: "Search",
    cat: "decide",
    state: "open",
    risk: 1,
    tags: ["tier 2"],
    add: 58,
    del: 22,
    files: 3,
    checks: [14, 14, "pass"],
    sha: "e90b1f6",
    patch: "6d3e88f2",
    opened: 220,
    act: [25, "new commit · your signature dropped"],
    reasons: [
      ["module-tier", "modules/search is tier 2", "needs prompter self-attest", true],
      [
        "attestation",
        "signed patch-id 51c0… no longer matches (content changed)",
        "attestation dropped",
        true,
      ],
    ],
    policy: "tier2-module-change",
    req: "Prompter self-attest",
    slots: [
      {
        role: "prompter",
        label: "Prompter",
        who: "mara",
        state: "stale",
        nod: { min: 198, sha: "0c4d7aa", via: null },
      },
    ],
    brief: {
      what: "Facet counts no longer include archived items. Since your signature: +14 −3 in facets.ts to also cover soft-deleted items.",
      why: "Bug #468. The follow-up commit answers Ines' review comment.",
      risk: "Low. Read path only.",
      verified: "Two new test cases; counts compared with SQL on staging.",
      lookAt: ["modules/search/facets.ts (changed since you signed)"],
    },
  },
  {
    n: 479,
    title: "core: typed channels for the event bus",
    by: "mara",
    agent: "Claude Code",
    topic: "Core event bus",
    cat: "decide",
    state: "open",
    risk: 3,
    tags: ["core"],
    add: 684,
    del: 402,
    files: 31,
    checks: [14, 14, "pass"],
    sha: "b61a0d3",
    patch: "f2281c4a",
    opened: 23 * H + 30,
    act: [1370, "you signed · waits on Ines"],
    reasons: [
      ["touches-core", "12 files under core/events/", "needs prompter + named owner", true],
      ["owner", "core/events/** is owned by Ines", "named person: Ines"],
      ["diff-size", "+684 −402 in 31 files (limit 600)", "risk raised to high", true],
    ],
    policy: "core-change",
    req: "Prompter self-attest + named owner (Ines)",
    slots: [
      {
        role: "prompter",
        label: "Prompter",
        who: "mara",
        state: "ok",
        nod: { min: 1370, sha: "4ac19e2", via: "patch_id" },
      },
      { role: "owner", label: "Owner of core/events", who: "ines", state: "missing" },
    ],
    brief: {
      what: "Event bus channels get a typed payload schema; 19 modules migrated mechanically.",
      why: "Three production bugs this quarter came from mistyped event payloads.",
      risk: "Large core change. Mostly mechanical, but publish() ordering changed for batched events.",
      verified:
        "Full suite green; type-level tests; canary on staging for 24h without dropped events.",
      lookAt: ["core/events/bus.ts", "core/events/channel.ts"],
    },
    epic: EVENTS,
  },
  {
    n: 492,
    title: "deps: drizzle-orm 0.36.4 → 0.37.0",
    by: "jonas",
    agent: "Renovate + Claude Code",
    topic: "Housekeeping",
    cat: "decide",
    state: "open",
    risk: 2,
    tags: ["deps"],
    add: 44,
    del: 31,
    files: 6,
    lockfile: { add: 118, del: 97 },
    checks: [14, 14, "pass"],
    sha: "6ad00e1",
    patch: "0be7719c",
    opened: 246,
    act: [240, "opened"],
    reasons: [
      ["deps", "minor bump of a database library", "needs prompter self-attest", true],
      ["lockfile", "lockfile + 4 call sites changed", "no change"],
    ],
    policy: "dep-minor-db",
    req: "Prompter self-attest",
    slots: [{ role: "prompter", label: "Prompter", who: "jonas", state: "missing" }],
    brief: {
      what: "Minor bump; 4 call sites adapted to the renamed `onConflictDoUpdate` option.",
      why: "Needed for the batched backfill helper used in #485.",
      risk: "Medium. Database library.",
      verified: "Full suite green, migration dry-run unchanged.",
      lookAt: ["package.json", "modules/billing/repo.ts"],
    },
  },
  {
    n: 483,
    title: "billing: round tax per line item, not per invoice",
    by: "jonas",
    agent: "Claude Code",
    topic: "Billing v2",
    cat: "decide",
    state: "open",
    risk: 2,
    tags: ["tier 3"],
    add: 77,
    del: 49,
    files: 4,
    checks: [12, 14, "run"],
    sha: "c77e0f1",
    patch: "7be2d403",
    opened: 360,
    act: [270, "you signed · checks running"],
    reasons: [["module-tier", "modules/billing is tier 3", "needs another human", true]],
    policy: "tier3-module-change",
    req: "Another human (not the prompter)",
    slots: [
      {
        role: "peer",
        label: "Peer",
        who: null,
        except: "jonas",
        state: "ok",
        nod: { min: 272, sha: "a1d94e2", via: "patch_id" },
      },
    ],
    brief: {
      what: "Tax is rounded per line, matching what the accounting export expects.",
      why: "Epic #431. 1-cent differences against the ledger.",
      risk: "Money math, small diff.",
      verified: "Golden-file test with 1,200 historical invoices.",
      lookAt: ["modules/billing/tax.ts"],
    },
    epic: BILLING,
  },
  {
    n: 478,
    title: "ci: run vitest in workspace mode (tests 3× faster)",
    by: "ines",
    agent: "Claude Code",
    topic: "Housekeeping",
    cat: "fyi",
    state: "open",
    risk: 0,
    tags: ["tooling"],
    add: 139,
    del: 212,
    files: 14,
    checks: [13, 14, "run"],
    sha: "31f8b2c",
    patch: "d9a04e55",
    opened: 180,
    act: [180, "Ines signed"],
    reasons: [
      [
        "paths",
        "only .github/, vitest.*.ts, package.json scripts",
        "needs prompter self-attest",
        true,
      ],
      ["author-fyi", 'author declared FYI: "test commands change"', "FYI to the whole team"],
    ],
    policy: "tooling-change",
    req: "Prompter self-attest",
    slots: [
      {
        role: "prompter",
        label: "Prompter",
        who: "ines",
        state: "ok",
        nod: { min: 160, sha: "31f8b2c", via: "head_sha" },
      },
    ],
    fyi: {
      reason: "declared by author: test commands change",
      source: "declared",
      acked: ["jonas"],
      pending: ["mara"],
    },
    brief: {
      what: "One vitest workspace instead of 23 per-module configs. `pnpm test` is now `pnpm test --project <module>`.",
      why: "CI test stage went from 9m to 3m.",
      risk: "None for production. Your local test command changes.",
      verified: "Same 4,812 tests discovered before and after.",
      lookAt: ["vitest.workspace.ts", "docs/dev/testing.md"],
    },
  },
  {
    n: 487,
    title: "docs: ADR-014 module tiers and review requirements",
    by: "ines",
    agent: "Claude Code",
    topic: "Housekeeping",
    cat: "fyi",
    state: "merged",
    risk: 0,
    tags: ["docs"],
    add: 164,
    del: 0,
    files: 2,
    checks: [6, 6, "pass"],
    sha: "0d92e7b",
    patch: "88c13fa0",
    opened: 64,
    act: [60, "merged"],
    merged: 60,
    reasons: [
      ["docs-only", "only files under docs/", "auto-merge"],
      ["author-fyi", 'author declared FYI: "changes how we review"', "FYI to the whole team"],
    ],
    policy: "docs-only",
    req: "None (auto-merge)",
    slots: [],
    fyi: {
      reason: "declared by author: changes how we review",
      source: "declared",
      acked: ["jonas"],
      pending: ["mara"],
    },
    brief: {
      what: "Writes down which module is tier 1, 2 or 3 and what each tier requires. Moves `calendar` from tier 2 to tier 1.",
      why: "The tiers so far lived only in the policy file.",
      risk: "None. But it is the reference for the policy config.",
      verified: "n/a (docs).",
      lookAt: ["docs/adr/014-module-tiers.md"],
    },
  },
  {
    n: 480,
    title: "core: deprecate ctx.legacyDb in the module SDK",
    by: "ines",
    agent: "Claude Code",
    topic: "Core event bus",
    cat: "fyi",
    state: "merged",
    risk: 0,
    tags: ["core"],
    add: 52,
    del: 9,
    files: 5,
    checks: [14, 14, "pass"],
    sha: "ab30c19",
    patch: "2e6f0d71",
    opened: 20 * H + 30,
    act: [1189, "merged"],
    merged: 1189,
    reasons: [
      ["touches-core", "2 files under core/sdk/", "needs prompter + named owner", true],
      ["fyi-rule", "public module SDK surface changed", "FYI to the whole team"],
    ],
    policy: "core-change",
    req: "Prompter self-attest + named owner (Ines)",
    slots: [
      {
        role: "prompter",
        label: "Prompter + owner",
        who: "ines",
        state: "ok",
        nod: { min: 1200, sha: "ab30c19", via: "head_sha" },
      },
    ],
    fyi: {
      reason: "policy: module SDK surface changed",
      source: "policy",
      acked: [],
      pending: ["mara", "jonas"],
    },
    brief: {
      what: "`ctx.legacyDb` now logs a deprecation warning; removal planned for 1 Dec.",
      why: "Last step before modules can only reach the DB through repositories.",
      risk: "None now. Agents writing modules must stop using it.",
      verified: "Warning appears once per process in tests.",
      lookAt: ["core/sdk/context.ts", "docs/modules/sdk.md"],
    },
    epic: EVENTS,
  },
  {
    n: 493,
    title: "notes: keyboard shortcut to toggle checklist items",
    by: "mara",
    agent: "Claude Code",
    topic: "Notes",
    cat: "auto",
    state: "open",
    risk: 0,
    tags: ["tier 1"],
    add: 37,
    del: 2,
    files: 3,
    checks: [13, 14, "fail"],
    failing: ["e2e (firefox)"],
    sha: "5f0e2d8",
    patch: "b7c9e014",
    opened: 15,
    act: [6, "fix pushed for the failing check"],
    reasons: [["module-tier", "modules/notes is tier 1, pure module update", "auto-merge"]],
    policy: "tier1-pure-module",
    req: "None (auto-merge)",
    slots: [],
    brief: {
      what: "Cmd+Enter toggles a checklist item.",
      why: "Issue #470.",
      risk: "None.",
      verified: "e2e test failing on Firefox; agent is fixing.",
      lookAt: [],
    },
  },
  {
    n: 481,
    title: "calendar: ICS export honours the tenant timezone",
    by: "ines",
    agent: "Claude Code",
    topic: "Calendar",
    cat: "auto",
    state: "open",
    risk: 0,
    tags: ["tier 1"],
    add: 45,
    del: 12,
    files: 3,
    checks: [9, 14, "run"],
    sha: "13c9a7e",
    patch: "40ad81b3",
    opened: 12,
    act: [12, "opened"],
    reasons: [["module-tier", "modules/calendar is tier 1, pure module update", "auto-merge"]],
    policy: "tier1-pure-module",
    req: "None (auto-merge)",
    slots: [],
    brief: {
      what: "ICS export uses the tenant timezone instead of UTC.",
      why: "Bug #472.",
      risk: "None.",
      verified: "Unit tests for 4 timezones.",
      lookAt: [],
    },
  },
  {
    n: 489,
    title: "deps: zod 3.24.1 → 3.24.2",
    by: "jonas",
    agent: "Renovate",
    topic: "Housekeeping",
    cat: "auto",
    state: "merged",
    risk: 0,
    tags: ["deps"],
    add: 6,
    del: 6,
    files: 2,
    lockfile: { add: 9, del: 9 },
    checks: [14, 14, "pass"],
    sha: "f41d6b9",
    patch: "9912ce07",
    opened: 40,
    act: [35, "merged"],
    merged: 35,
    reasons: [["deps", "patch bump, lockfile only", "auto-merge"]],
    policy: "dep-patch",
    req: "None (auto-merge)",
    slots: [],
    brief: {
      what: "Patch bump.",
      why: "Renovate.",
      risk: "None.",
      verified: "Suite green.",
      lookAt: [],
    },
  },
  {
    n: 486,
    title: "notes: fix pasting markdown tables",
    by: "mara",
    agent: "Claude Code",
    topic: "Notes",
    cat: "auto",
    state: "merged",
    risk: 0,
    tags: ["tier 1"],
    add: 64,
    del: 19,
    files: 3,
    checks: [14, 14, "pass"],
    sha: "7a3e15c",
    patch: "5d08f6aa",
    opened: 150,
    act: [120, "merged"],
    merged: 120,
    reasons: [["module-tier", "modules/notes is tier 1, pure module update", "auto-merge"]],
    policy: "tier1-pure-module",
    req: "None (auto-merge)",
    slots: [],
    brief: {
      what: "Pasted tables keep their columns.",
      why: "Bug #466.",
      risk: "None.",
      verified: "6 paste fixtures.",
      lookAt: [],
    },
  },
  {
    n: 484,
    title: "deps: @types/node 22.9.0 → 22.9.1",
    by: "jonas",
    agent: "Renovate",
    topic: "Housekeeping",
    cat: "auto",
    state: "merged",
    risk: 0,
    tags: ["deps"],
    add: 4,
    del: 4,
    files: 2,
    lockfile: { add: 6, del: 6 },
    checks: [14, 14, "pass"],
    sha: "c0b8d22",
    patch: "1f6a7e30",
    opened: 372,
    act: [368, "merged"],
    merged: 368,
    reasons: [["deps", "patch bump of a dev dependency", "auto-merge"]],
    policy: "dep-patch",
    req: "None (auto-merge)",
    slots: [],
    brief: {
      what: "Patch bump.",
      why: "Renovate.",
      risk: "None.",
      verified: "Suite green.",
      lookAt: [],
    },
  },
  {
    n: 477,
    title: "docs: fix typos in the module authoring guide",
    by: "jonas",
    agent: "Claude Code",
    topic: "Housekeeping",
    cat: "auto",
    state: "merged",
    risk: 0,
    tags: ["docs"],
    add: 11,
    del: 11,
    files: 1,
    checks: [6, 6, "pass"],
    sha: "92e4f0a",
    patch: "e3b15c88",
    opened: 1160,
    act: [1155, "merged"],
    merged: 1155,
    reasons: [["docs-only", "only files under docs/", "auto-merge"]],
    policy: "docs-only",
    req: "None (auto-merge)",
    slots: [],
    brief: { what: "Typos.", why: "", risk: "None.", verified: "n/a", lookAt: [] },
  },
];

function file(path: string, added: number, removed: number, area: string): FileChange {
  return { path, added, removed, area, excluded: null };
}

/** Open PRs the verifier has not seen yet (the first-run dashboard). */
export const UNCLASSIFIED_TITLES = [
  "billing: prorate plan changes mid-cycle",
  "billing: add invoices.currency_code with backfill",
  "auth: rotate session tokens on privilege change",
  "inventory: release stock when a reservation times out",
  "notifications: batch digest emails per tenant",
  "search: fix facet counts when items are archived",
  "core: typed channels for the event bus",
];

const MIN = 60_000;

export function prUrl(repo: string, n: number): string {
  return `https://github.com/${repo}/pull/${n}`;
}

/** One seed as `PrFacts`, with times relative to `now`. */
export function seedFacts(seed: Seed, now: number, repo = FAKE_REPO): PrFacts {
  const ago = (min: number) => now - min * MIN;
  const login = (w: Who) => FAKE_PEOPLE[w].login;
  const signatures: Omit<Signature, "byMe">[] = [];
  const slots: Slot[] = seed.slots.map((s) => {
    let signature: number | null = null;
    if (s.nod) {
      // A peer slot in this data set was always filled by Mara.
      const by: Who = s.who ?? "mara";
      const matched = s.nod.via;
      signatures.push({
        by: login(by),
        level: by === seed.by ? "self" : "peer",
        at: ago(s.nod.min),
        headSha: fakeHex(s.nod.sha),
        patchId: matched === null ? fakeHex("51c0", String(seed.n)) : fakeHex(seed.patch),
        matchedBy: matched,
        counts: s.state === "ok",
        why: s.state === "stale" ? "content changed since" : null,
        batchSize: 1,
        commentUrl: `${prUrl(repo, seed.n)}#issuecomment-${seed.n}00${signatures.length + 1}`,
      });
      signature = signatures.length - 1;
    }
    return {
      role: s.role,
      label: s.label,
      who: s.who ? login(s.who) : null,
      except: s.except ? login(s.except) : null,
      state: s.state,
      signature,
    };
  });

  const ev = (
    kind: JourneyEvent["kind"],
    text: string,
    at: number,
    detail: string | null = null,
    tone: JourneyEvent["tone"] = "plain",
  ): JourneyEvent => ({ kind, text, detail, at, phase: "done", tone });
  const journey: JourneyEvent[] = [
    ev("opened", "Opened", ago(seed.opened), seed.agent),
    ev(
      "classified",
      "Classified",
      ago(seed.opened) + MIN,
      slots.length === 0 ? "auto-merge" : slots.length > 1 ? "needs 2 people" : "needs 1 signature",
    ),
  ];
  for (const s of slots) {
    if (s.signature === null) continue;
    const sig = signatures[s.signature]!;
    const name = sig.by === FAKE_ME ? "You" : personName(sig.by);
    journey.push(ev("nodded", `${name} signed`, sig.at));
    if (sig.matchedBy === "patch_id")
      journey.push(ev("rebased", "Rebased", sig.at + 15 * MIN, "signature held"));
    if (s.state === "stale")
      journey.push(
        ev("nod-dropped", "Content changed", ago(seed.act[0]), "signature dropped", "bad"),
      );
  }
  if (seed.requested !== undefined)
    journey.push(ev("requested", "Review requested", ago(seed.requested), "by Jonas’s agent"));
  if (seed.moved)
    journey.push(
      ev("pushed", `${seed.moved.commits} new commits`, ago(seed.moved.min), "after the request"),
    );
  if (seed.checks[2] === "fail")
    journey.push(
      ev(
        "checks",
        "Check failed",
        ago(seed.act[0]) - 5 * MIN,
        seed.failing?.join(", ") ?? null,
        "bad",
      ),
    );
  if (seed.merged !== undefined)
    journey.push(ev("merged", "Merged", ago(seed.merged), "by the agent"));
  journey.sort((a, b) => a.at! - b.at!);

  const reasons: Reason[] = seed.reasons.map(([classifier, fact, effect, raises]) => ({
    classifier,
    fact,
    effect,
    raises: raises ?? false,
  }));
  const fyi: Fyi | null = seed.fyi
    ? {
        reason: seed.fyi.reason,
        source: seed.fyi.source,
        acked: seed.fyi.acked.map(login),
        pending: seed.fyi.pending.map(login),
      }
    : null;
  const [passed, total, cs] = seed.checks;
  return {
    number: seed.n,
    title: seed.title,
    url: prUrl(repo, seed.n),
    state: seed.state,
    author: login(seed.by),
    prompter: login(seed.by),
    agent: seed.agent,
    topic: seed.topic,
    category: seed.cat,
    risk: seed.risk,
    tags: seed.tags,
    base: "main",
    headSha: fakeHex(seed.sha),
    patchId: fakeHex(seed.patch),
    openedAt: ago(seed.opened),
    mergedAt: seed.merged === undefined ? null : ago(seed.merged),
    diff: {
      added: seed.add,
      removed: seed.del,
      files: seed.files,
      excluded: seed.lockfile
        ? { added: seed.lockfile.add, removed: seed.lockfile.del, files: 1 }
        : { added: 0, removed: 0, files: 0 },
    },
    checks: {
      state: cs === "pass" ? "passing" : cs === "run" ? "pending" : "failing",
      passed,
      total,
      failing: seed.failing ?? [],
    },
    requirement: { policy: seed.policy, label: seed.req, slots },
    signatures,
    reasons,
    fyi,
    brief: seed.brief,
    epic: seed.epic ?? null,
    dependsOn: seed.dependsOn ?? [],
    journey,
    files: seed.fileList ?? null,
    lastActivity: { at: ago(seed.act[0]), text: seed.act[1] },
    // The current head's requirement started waiting when it was last pushed.
    waitingSince: seed.moved
      ? ago(seed.moved.min)
      : seed.slots.some((s) => s.state === "stale")
        ? ago(seed.act[0])
        : null,
  };
}

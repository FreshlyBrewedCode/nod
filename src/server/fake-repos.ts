/**
 * The `repos` scenario of `nod serve --fake` (ADR 0007): the fake team
 * reads three repos in one inbox, each at its own step of the ladder.
 *
 * - `tallyho/fieldbook` (github.com): the mockup's repo (`fake-data.ts`),
 *   enforced, my key active.
 * - `tallyho/field-app` (github.com): the inbox step (`fake-inbox.ts`): no
 *   `.nod/`, my key not enrolled, the PRs classified locally.
 * - `acme.ghe.com/finance/ledger`: a fictional GHE.com host, the shared
 *   policy (its check is not required yet), my key active there too, so a
 *   nod batch can span two repos (one signature per repo). The PRs below.
 *
 * Fictional people, repos and host only, as everywhere.
 */

import type { Seed } from "./fake-data";
import { file } from "./fake-data";

export const FIELD_APP = "tallyho/field-app";
export const LEDGER_HOST = "acme.ghe.com";
export const LEDGER = "finance/ledger";

const CLOSE = { number: 31, title: "Monthly close" };

/** The ledger's PRs: a younger repo, so the numbers are small. */
export const LEDGER_SEEDS: ReadonlyArray<Seed> = [
  {
    n: 57,
    title: "journal: reject imports whose debits and credits differ",
    by: "jonas",
    agent: "Claude Code",
    topic: "Journal import",
    cat: "decide",
    state: "open",
    risk: 2,
    tags: ["core"],
    add: 148,
    del: 22,
    files: 5,
    checks: [8, 8, "pass"],
    sha: "c07e1a4",
    patch: "9b2d6f10",
    opened: 95,
    act: [80, "Jonas’s agent asked for a peer"],
    reasons: [
      ["touches-core", "changes ledger/core/journal.ts", "needs another human", true],
      ["diff-size", "+148 −22 in 5 files (limit 600)", "no change"],
    ],
    policy: "core-change",
    req: "Another human (not the prompter)",
    slots: [{ role: "peer", label: "Peer", who: null, except: "jonas", state: "missing" }],
    brief: {
      what: "A journal import is refused when its debits and credits do not add up to zero, with the first unbalanced entry in the error.",
      why: "Two imports last month were posted half-balanced and had to be reversed by hand.",
      risk: "Imports that were accepted before may now be refused; the error names the line.",
      verified:
        "Property test over 10,000 random journals; re-ran the last 90 days of imports from staging: none refused.",
      lookAt: ["ledger/core/journal.ts", "ledger/import/validate.ts"],
    },
    fileList: [
      file("ledger/core/journal.ts", 64, 12, "core"),
      file("ledger/import/validate.ts", 51, 6, "import"),
      file("ledger/import/validate.test.ts", 33, 4, "import · test"),
    ],
  },
  {
    n: 58,
    title: "close: lock posted periods after the monthly close",
    by: "ines",
    agent: "Codex",
    topic: "Monthly close",
    cat: "decide",
    state: "open",
    risk: 3,
    tags: ["migration", "core"],
    add: 210,
    del: 31,
    files: 7,
    checks: [7, 8, "run"],
    sha: "e5a90b2",
    patch: "13fe7a28",
    opened: 240,
    act: [35, "checks running"],
    reasons: [
      ["migration", "adds db/migrations/0012_period_locks.sql", "needs another human", true],
      ["touches-core", "changes ledger/core/periods.ts", "needs another human", true],
    ],
    policy: "schema-migration",
    req: "Another human (not the prompter)",
    slots: [{ role: "peer", label: "Peer", who: null, except: "ines", state: "missing" }],
    brief: {
      what: "A closed period is locked: postings into it are refused, corrections go into the open period with a reference.",
      why: `Epic #${CLOSE.number} ${CLOSE.title}. Auditors asked for closed months to stay as reported.`,
      risk: "Schema migration on the periods table (small). A wrong lock date would refuse today’s postings.",
      verified: "Migration run on a staging copy; tests for postings on both sides of the lock.",
      lookAt: ["db/migrations/0012_period_locks.sql", "ledger/core/periods.ts"],
    },
    epic: CLOSE,
  },
  {
    n: 54,
    title: "reports: trial balance as CSV",
    by: "mara",
    agent: "Claude Code",
    topic: "Reports",
    cat: "decide",
    state: "open",
    risk: 1,
    tags: ["reports"],
    add: 88,
    del: 3,
    files: 3,
    checks: [8, 8, "pass"],
    sha: "4d21c6b",
    patch: "7ae0c533",
    opened: 60,
    act: [55, "checks turned green"],
    reasons: [["module-tier", "ledger/reports is a leaf module", "needs prompter self-attest", true]],
    policy: "leaf-module-change",
    req: "Prompter self-attest",
    slots: [{ role: "prompter", label: "Prompter", who: "mara", state: "missing" }],
    brief: {
      what: "The trial balance downloads as CSV, one row per account, in the ledger’s currency.",
      why: "Finance pastes it into the close checklist every month.",
      risk: "Low: a read-only report.",
      verified: "Snapshot test of the CSV for a fixture ledger.",
      lookAt: ["ledger/reports/trial-balance.ts"],
    },
  },
  {
    n: 56,
    title: "docs: reconciliation runbook",
    by: "ines",
    agent: "Claude Code",
    topic: "Docs",
    cat: "fyi",
    state: "open",
    risk: 0,
    tags: ["docs"],
    add: 74,
    del: 0,
    files: 1,
    checks: [8, 8, "pass"],
    sha: "a3c88f1",
    patch: "2d4b9e07",
    opened: 300,
    act: [290, "opened"],
    reasons: [["docs-only", "only docs/ changed", "FYI for the team"]],
    policy: "docs-only",
    req: "None (auto-merge)",
    slots: [],
    fyi: {
      reason: "policy: the runbook changes how the close is done",
      source: "policy",
      acked: ["jonas"],
      pending: ["mara"],
    },
    brief: {
      what: "Writes down how a bank reconciliation is done, and who signs it off.",
      why: "It lived in one person’s head.",
      risk: "None.",
      verified: "Read through with the team.",
      lookAt: ["docs/runbooks/reconciliation.md"],
    },
  },
  {
    n: 53,
    title: "deps: decimal.js 10.4.3 → 10.5.0",
    by: "jonas",
    agent: "Renovate",
    topic: "Housekeeping",
    cat: "auto",
    state: "merged",
    risk: 0,
    tags: ["deps"],
    add: 4,
    del: 4,
    files: 1,
    lockfile: { add: 18, del: 18 },
    checks: [8, 8, "pass"],
    sha: "6b0f2e9",
    patch: "0c71aa54",
    opened: 400,
    act: [380, "merged"],
    merged: 380,
    reasons: [["deps", "a patch release of a dependency", "auto-merge"]],
    policy: "deps-patch",
    req: "None (auto-merge)",
    slots: [],
    brief: {
      what: "Bumps decimal.js.",
      why: "Patch release.",
      risk: "None.",
      verified: "CI.",
      lookAt: [],
    },
  },
];

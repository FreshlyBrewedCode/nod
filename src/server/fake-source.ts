/**
 * An in-memory `Source` for `nod serve --fake`: the mockup's team and repo
 * (`fake-data.ts`), alive enough to click through the UI.
 *
 * - Signing fills my slots the way the verifier would; a PR whose
 *   requirement is met "merges" a few seconds later (after its checks).
 * - With `live`, a few things happen on their own: running checks finish,
 *   the failing one gets fixed, and those PRs merge.
 * - Scenarios start it in the states the r3 UI has: `team` (the mockup),
 *   `clear` (nothing needs you), `first-run` (setup PR open, key pending),
 *   `fresh` (onboarding from step 1, no key), `join` (a set-up repo, no key).
 */

import type {
  Account,
  Enrolment,
  GitHubInfo,
  JourneyEvent,
  PrLink,
  RepoChoice,
  RepoName,
  SetupCheck,
  SetupStatus,
  Signature,
  Snapshot,
} from "../shared/protocol";
import { GITHUB_COM, githubHost } from "../kit/host.ts";
import type { Clock, Timer } from "./clock";
import { FAKE_KEY } from "./signer";
import { publicKeyId } from "./signer/ssh-wire";
import {
  FAKE_ME,
  FAKE_PEOPLE,
  FAKE_REPO,
  SEEDS,
  UNCLASSIFIED_TITLES,
  prUrl,
  seedFacts,
} from "./fake-data";
import {
  SourceError,
  type PostNodInput,
  type PostResult,
  type SignTarget,
  type Source,
  type SourceChange,
} from "./source";
import { canFill, sameLogin, toViews, type PrFacts } from "./view";

export const FAKE_SCENARIOS = ["team", "clear", "first-run", "fresh", "join"] as const;
export type FakeScenario = (typeof FAKE_SCENARIOS)[number];

/** Whether the scenario starts with a signing key (the fake signer's `hasKey`). */
export function scenarioHasKey(scenario: FakeScenario): boolean {
  return scenario !== "fresh" && scenario !== "join";
}

export interface FakeSourceOptions {
  readonly clock: Clock;
  readonly scenario?: FakeScenario;
  /** Show the data set under another repo name. */
  readonly repo?: RepoName;
  /** Let checks finish and PRs merge on their own. Off in tests. */
  readonly live?: boolean;
  /** From "requirement met and checks green" to merged. */
  readonly mergeDelayMs?: number;
  /** The public key the scenario treats as mine (default the fake signer's). */
  readonly myKey?: string;
}

const SETUP_PR = 494;
const ENROL_PR = 501;
const SECOND = 1000;

export const FAKE_ACCOUNT: Account = {
  login: FAKE_ME,
  name: FAKE_PEOPLE.mara.name,
  scopes: ["repo", "read:org", "workflow"],
};

type SetupState = SetupStatus["state"];

export class FakeSource implements Source {
  private readonly clock: Clock;
  private readonly mergeDelayMs: number;
  private readonly started: number;
  private facts: PrFacts[] = [];
  private unclassified: Snapshot["unclassified"] = [];
  private repoName: RepoName | null;
  private setupState: SetupState;
  private setupPr: PrLink | null = null;
  /** By `publicKeyId`: the key, not its comment. */
  private readonly enrolments = new Map<string, Enrolment>();
  private readonly listeners = new Set<(change: SourceChange) => void>();
  private readonly timers: Timer[] = [];
  private syncAt: number;
  private comments = 0;

  constructor(options: FakeSourceOptions) {
    const scenario = options.scenario ?? "team";
    this.clock = options.clock;
    this.mergeDelayMs = options.mergeDelayMs ?? 4 * SECOND;
    this.started = this.clock.now();
    this.syncAt = this.started;
    const repo = options.repo ?? FAKE_REPO;
    this.repoName = scenario === "fresh" ? (options.repo ?? null) : repo;
    this.setupState = scenario === "fresh" ? (options.repo ? "missing" : "none") : "ready";

    if (scenario === "team" || scenario === "clear" || scenario === "join")
      this.facts = SEEDS.map((s) => seedFacts(s, this.started, repo));
    const myKey = publicKeyId(options.myKey ?? FAKE_KEY.publicKey);
    if (scenario === "team" || scenario === "clear")
      this.enrolments.set(myKey, { state: "active" });
    if (scenario === "clear") this.facts = this.facts.map((f) => this.alreadyDone(f));
    if (scenario === "first-run") {
      this.setupState = "pending";
      this.setupPr = { number: SETUP_PR, url: prUrl(repo, SETUP_PR) };
      this.enrolments.set(myKey, { state: "pending", pr: this.setupPr });
      this.unclassified = UNCLASSIFIED_TITLES.map((title, i) => {
        const number = SEEDS.filter((s) => s.state === "open")[i]?.n ?? 470 + i;
        return { number, title, url: prUrl(repo, number) };
      });
    }

    if (options.live) this.startLife();
    // Time-dependent fields (stuck after 12 h) move without anything happening.
    this.timers.push(this.clock.every(60 * SECOND, () => this.emit("prs")));
  }

  // -- Source ---------------------------------------------------------------

  async account(): Promise<Account | null> {
    return FAKE_ACCOUNT;
  }

  async listRepos(): Promise<ReadonlyArray<RepoChoice>> {
    const now = this.clock.now();
    return [
      {
        repo: this.repoName ?? FAKE_REPO,
        current: true,
        canWrite: true,
        pushedAt: now - 10 * 60 * SECOND,
      },
      {
        repo: "tallyho/fieldbook-docs",
        current: false,
        canWrite: true,
        pushedAt: now - 3 * 86_400 * SECOND,
      },
    ];
  }

  repo(): RepoName | null {
    return this.repoName;
  }

  github(): GitHubInfo {
    const { name, webUrl } = githubHost(GITHUB_COM);
    return { host: name, webUrl };
  }

  async pickRepo(repo: RepoName): Promise<void> {
    if (!/^[\w.-]+\/[\w.-]+$/.test(repo))
      throw new SourceError("not-found", `No repository ${repo}.`);
    if (sameLogin(repo, this.repoName)) return;
    // Another repo than the data set's: not set up, nothing to show.
    this.repoName = repo;
    this.facts = [];
    this.unclassified = [];
    this.setupState = "missing";
    this.setupPr = null;
    this.emit("setup");
    this.emit("prs");
  }

  snapshot(): Snapshot | null {
    if (!this.repoName) return null;
    const people = Object.values(FAKE_PEOPLE);
    return {
      repo: this.repoName,
      me: FAKE_ME,
      people,
      prs: toViews(this.facts, { me: FAKE_ME, now: this.clock.now(), people }),
      unclassified: this.unclassified,
      sync: { at: this.syncAt, error: null },
    };
  }

  async refresh(): Promise<void> {
    this.syncAt = this.clock.now();
    this.emit("prs");
  }

  async signTarget(pr: number): Promise<SignTarget | null> {
    const f = this.facts.find((x) => x.number === pr);
    return f ? { pr, state: f.state, base: f.base, headSha: f.headSha, patchId: f.patchId } : null;
  }

  async postNod(input: PostNodInput): Promise<ReadonlyArray<PostResult>> {
    const { payload } = input;
    const results: PostResult[] = [];
    for (const entry of payload.entries) {
      const index = this.facts.findIndex((f) => f.number === entry.pr);
      if (index < 0 || !sameLogin(payload.repo, this.repoName)) {
        results.push({
          pr: entry.pr,
          ok: false,
          url: null,
          message: `#${entry.pr} is not in ${this.repoName}.`,
        });
        continue;
      }
      const f = this.facts[index]!;
      const url = `${f.url}#issuecomment-${9_000_000 + ++this.comments}`;
      this.facts[index] = this.withNod(f, payload.reviewer, entry, payload.entries.length, url);
      results.push({ pr: entry.pr, ok: true, url, message: null });
      this.whenReady(entry.pr);
    }
    this.emit("prs");
    return results;
  }

  async ackFyi(pr: number): Promise<void> {
    const index = this.facts.findIndex((f) => f.number === pr);
    const f = this.facts[index];
    if (!f?.fyi) throw new SourceError("not-found", `#${pr} has no FYI.`);
    if (!f.fyi.pending.some((l) => sameLogin(l, FAKE_ME))) return;
    const at = this.clock.now();
    this.facts[index] = {
      ...f,
      fyi: {
        ...f.fyi,
        acked: [...f.fyi.acked, FAKE_ME],
        pending: f.fyi.pending.filter((l) => !sameLogin(l, FAKE_ME)),
      },
      journey: [...f.journey, event("fyi-acked", "You got it", at)],
    };
    this.emit("prs");
  }

  async setup(): Promise<SetupStatus> {
    return setupStatus(this.repoName, this.setupState, this.setupPr);
  }

  async openSetupPr(publicKey: string | null): Promise<PrLink> {
    if (!this.repoName || this.setupState === "none")
      throw new SourceError("no-repo", "Pick a repository first.");
    if (this.setupState === "ready")
      throw new SourceError("already-set-up", `${this.repoName} is set up already.`);
    if (!this.setupPr) {
      this.setupPr = { number: SETUP_PR, url: prUrl(this.repoName, SETUP_PR) };
      this.setupState = "pending";
      this.emit("setup");
    }
    if (publicKey) this.keyCreated(publicKey);
    return this.setupPr;
  }

  async openEnrolPr(publicKey: string): Promise<PrLink> {
    if (!this.repoName || this.setupState === "none")
      throw new SourceError("no-repo", "Pick a repository first.");
    const current = this.enrolment(publicKey);
    if (current.state === "active")
      throw new SourceError("already-enrolled", "Your key is enrolled already.");
    if (current.state === "pending" && current.pr) return current.pr;
    // Setting up the repo: the first key rides in the setup PR.
    const pr =
      this.setupState === "pending" && this.setupPr
        ? this.setupPr
        : { number: ENROL_PR, url: prUrl(this.repoName, ENROL_PR) };
    this.enrolments.set(publicKeyId(publicKey), { state: "pending", pr });
    this.emit("enrolment");
    return pr;
  }

  enrolment(publicKey: string): Enrolment {
    return this.enrolments.get(publicKeyId(publicKey)) ?? { state: "not-enrolled" };
  }

  keyCreated(publicKey: string): void {
    if (
      this.setupState !== "pending" ||
      !this.setupPr ||
      this.enrolment(publicKey).state !== "not-enrolled"
    )
      return;
    this.enrolments.set(publicKeyId(publicKey), { state: "pending", pr: this.setupPr });
    this.emit("enrolment");
  }

  subscribe(listener: (change: SourceChange) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  stop(): void {
    for (const t of this.timers) t.clear();
    this.timers.length = 0;
    this.listeners.clear();
  }

  // -- the simulation -------------------------------------------------------

  private emit(change: SourceChange) {
    for (const listener of this.listeners) listener(change);
  }

  private update(pr: number, change: (f: PrFacts) => PrFacts) {
    const index = this.facts.findIndex((f) => f.number === pr);
    if (index < 0) return;
    this.facts[index] = change(this.facts[index]!);
    this.emit("prs");
  }

  /** A nod as the verifier would count it (ADR 0001, rule 5). */
  private withNod(
    f: PrFacts,
    reviewer: string,
    entry: PostNodInput["payload"]["entries"][number],
    batchSize: number,
    url: string,
  ): PrFacts {
    const at = this.clock.now();
    const matchedBy: Signature["matchedBy"] =
      entry.head_sha === f.headSha ? "head_sha" : entry.patch_id === f.patchId ? "patch_id" : null;
    const counts = matchedBy !== null && entry.base === f.base && f.state === "open";
    const index = f.signatures.length;
    const signatures = [
      ...f.signatures,
      {
        by: reviewer,
        level: sameLogin(reviewer, f.author) ? ("self" as const) : ("peer" as const),
        at,
        headSha: entry.head_sha,
        patchId: entry.patch_id,
        matchedBy,
        counts,
        why: counts ? null : entry.base !== f.base ? "base changed" : "content changed since",
        batchSize,
        commentUrl: url,
      },
    ];
    const slots = f.requirement.slots.map((s) =>
      counts && canFill(s, reviewer) ? { ...s, state: "ok" as const, signature: index } : s,
    );
    const you = sameLogin(reviewer, FAKE_ME);
    return {
      ...f,
      signatures,
      requirement: { ...f.requirement, slots },
      journey: [
        ...f.journey,
        event(
          "nodded",
          you ? "You signed" : `${reviewer} signed`,
          at,
          batchSize > 1 ? `batch of ${batchSize}` : null,
        ),
      ],
      lastActivity: { at, text: you ? "you signed" : `${reviewer} signed` },
    };
  }

  /** Merge once the requirement is met and the checks are green. */
  private whenReady(pr: number) {
    const f = this.facts.find((x) => x.number === pr);
    if (!f || f.state !== "open" || f.requirement.slots.some((s) => s.state !== "ok")) return;
    if (f.checks.state === "pending" || f.checks.state === "failing") return;
    this.timers.push(this.clock.after(this.mergeDelayMs, () => this.merge(pr)));
  }

  private merge(pr: number) {
    const at = this.clock.now();
    this.update(pr, (f) =>
      f.state !== "open"
        ? f
        : {
            ...f,
            state: "merged",
            mergedAt: at,
            journey: [...f.journey, event("merged", "Merged", at, "by the agent")],
            lastActivity: { at, text: "merged" },
          },
    );
  }

  private checksDone(pr: number, text = "checks turned green") {
    const at = this.clock.now();
    this.update(pr, (f) =>
      f.state !== "open"
        ? f
        : {
            ...f,
            checks: { ...f.checks, state: "passing", passed: f.checks.total, failing: [] },
            journey: [...f.journey, event("checks", "Checks green", at)],
            lastActivity: { at, text },
          },
    );
    this.whenReady(pr);
  }

  private startLife() {
    const at = (s: number, fn: () => void) => this.timers.push(this.clock.after(s * SECOND, fn));
    at(20, () => this.checksDone(481));
    at(30, () => this.checksDone(483));
    at(45, () => this.checksDone(478));
    at(90, () => {
      const now = this.clock.now();
      this.update(493, (f) => ({
        ...f,
        checks: { ...f.checks, state: "pending", passed: 9, failing: [] },
        journey: [...f.journey, event("pushed", "Fix pushed", now, "by the agent")],
        lastActivity: { at: now, text: "another fix pushed" },
      }));
    });
    at(120, () => this.checksDone(493));
  }

  /** The `clear` scenario: everything that needed me was nodded an hour ago. */
  private alreadyDone(f: PrFacts): PrFacts {
    const at = this.started - 60 * 60 * SECOND;
    let next = f;
    if (f.state === "open" && f.requirement.slots.some((s) => canFill(s, FAKE_ME))) {
      next = this.withNod(
        f,
        FAKE_ME,
        { pr: f.number, base: f.base, head_sha: f.headSha, patch_id: f.patchId ?? "" },
        1,
        `${f.url}#issuecomment-1`,
      );
      next = {
        ...next,
        signatures: next.signatures.map((s, i) =>
          i === next.signatures.length - 1 ? { ...s, at } : s,
        ),
      };
      if (next.requirement.slots.every((s) => s.state === "ok") && next.checks.state === "passing")
        next = {
          ...next,
          state: "merged",
          mergedAt: at + 5 * 60 * SECOND,
          lastActivity: { at: at + 5 * 60 * SECOND, text: "merged" },
        };
      else next = { ...next, lastActivity: { at, text: "you signed" } };
      next = {
        ...next,
        journey: next.journey.map((e) => (e.at === this.started ? { ...e, at } : e)),
      };
    }
    if (next.fyi?.pending.some((l) => sameLogin(l, FAKE_ME)))
      next = {
        ...next,
        fyi: {
          ...next.fyi,
          acked: [...next.fyi.acked, FAKE_ME],
          pending: next.fyi.pending.filter((l) => !sameLogin(l, FAKE_ME)),
        },
      };
    return next;
  }
}

function event(
  kind: JourneyEvent["kind"],
  text: string,
  at: number,
  detail: string | null = null,
): JourneyEvent {
  return { kind, text, detail, at, phase: "done", tone: "plain" };
}

export function setupStatus(
  repo: RepoName | null,
  state: SetupState,
  setupPr: PrLink | null,
): SetupStatus {
  const pending = setupPr ? `in #${setupPr.number}` : "pending";
  const check = (
    id: SetupCheck["id"],
    label: string,
    detail: string,
    adds: boolean,
  ): SetupCheck => ({
    id,
    label,
    detail,
    state:
      state === "ready"
        ? "ok"
        : state === "pending" && adds
          ? "pending"
          : state === "none"
            ? "unknown"
            : "missing",
    note:
      state === "ready" ? null : !adds ? "after merge" : state === "pending" ? pending : "missing",
  });
  return {
    repo,
    state,
    checks: [
      check("policy", "Policy file", ".nod/policy.ts", true),
      check("workflow", "Verifier workflow", ".github/workflows/nod.yml", true),
      check("allowed-signers", "Allowed signers", ".nod/allowed_signers", true),
      check(
        "required-check",
        "Required check on main",
        "ruleset: the nod check, required approvals 1 → 0",
        false,
      ),
    ],
    setupPr,
  };
}

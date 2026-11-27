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
 *   `fresh` (an empty repo list, no key), `join` (a set-up repo, no key),
 *   `inbox` (the ladder's step 0: no `.nod/`, no key, the PRs classified
 *   locally and "needs me" from review requests, `fake-inbox.ts`), `shared`
 *   (the ladder's step 1 with my key active: a set-up repo whose `nod` check
 *   is not required yet, and I am an admin, so enforcing is what is offered).
 *   Each of these reads one repo. `repos` reads three (ADR 0007,
 *   `fake-repos.ts`): the mockup's enforced repo, one at the inbox step, and
 *   one with the shared policy on a fictional GHE.com host. `dir` is `team`
 *   as `nod serve --dir` reads it: a fixed list of one clone. `insights`
 *   and `insights-error` are `team` with my own inbox (ADR 0009): the
 *   fixture in `inbox/fixture/`, and in `insights-error` a copy of it that
 *   breaks once its first results are in (`inbox/fake.ts`).
 * - The repo list is managed (but in `dir`): adding a repo puts it at the
 *   inbox step with no pull requests; a name with `missing` in it is not
 *   found, one with `private` in it is forbidden. Removing works on every
 *   repo, the last one too. Suggestions are fictional repos with my open
 *   PRs or review requests (`SUGGESTIONS`), without those of the list.
 * - Who I am in a repo: an admin everywhere but in `join`, where a
 *   teammate with write access joins. My login is per host (ADR 0007, 8):
 *   `mara-l` on github.com, `mara_acme` on the fictional GHE.com host, where
 *   the team are managed users (`FAKE_PEOPLE_ACME`).
 * - Only an enforced repo merges on its own: at `inbox` and `shared` a
 *   person merges, the fake leaves the PRs open.
 * - Without an active key in a repo (`fresh`, `join`, `inbox`, the inbox
 *   repo of `repos`) the asks there are GitHub approvals (ADR 0006);
 *   approving answers the review request and fills a slot that takes
 *   approvals. In `join` Ines approved #485 already.
 */

import type {
  Account,
  GhLogin,
  Enrolment,
  GitHubInfo,
  JourneyEvent,
  PrLink,
  RepoKey,
  RepoList,
  RepoName,
  RepoSuggestion,
  LadderStep,
  RepoPermission,
  SetupCheck,
  SetupStatus,
  Signature,
  Snapshot,
  UnclassifiedPr,
} from "../shared/protocol";
import { GITHUB_COM, githubHost } from "../kit/host.ts";
import { parseRepoInput, repoKey, sameRepo } from "../shared/repo-key";
import { inboxFacts } from "./fake-inbox";
import { FIELD_APP, LEDGER, LEDGER_HOST, LEDGER_SEEDS } from "./fake-repos";
import type { Clock, Timer } from "./clock";
import { FAKE_KEY } from "./signer";
import { publicKeyId } from "./signer/ssh-wire";
import {
  FAKE_ME,
  FAKE_PEOPLE,
  FAKE_PEOPLE_ACME,
  FAKE_REPO,
  SEEDS,
  UNCLASSIFIED_TITLES,
  personName,
  prUrl,
  seedFacts,
} from "./fake-data";
import {
  SourceError,
  type PostApprovalsInput,
  type PostNodInput,
  type PostResult,
  type SignTarget,
  type Source,
  type SourceChange,
  type SourceRepo,
} from "./source";
import { canFill, sameLogin, toViews, type PrFacts } from "./view";
import { fakeSubject } from "./inbox/fake-subjects";
import type { InboxSubject } from "./inbox/service";

export const FAKE_SCENARIOS = [
  "team",
  "clear",
  "first-run",
  "fresh",
  "join",
  "inbox",
  "shared",
  "repos",
  "dir",
  "insights",
  "insights-error",
] as const;
export type FakeScenario = (typeof FAKE_SCENARIOS)[number];

/** Whether the scenario starts with a signing key (the fake signer's `hasKey`). */
export function scenarioHasKey(scenario: FakeScenario): boolean {
  return scenario !== "fresh" && scenario !== "join" && scenario !== "inbox";
}

/**
 * Repos worth adding, as one search per host would find them: fictional,
 * on github.com and the fake's GHE.com host. Those of the list are left out.
 */
export const SUGGESTIONS: ReadonlyArray<{
  readonly host: string;
  readonly name: RepoName;
  readonly myOpenPrs: number;
  readonly reviewRequests: number;
}> = [
  { host: GITHUB_COM, name: FAKE_REPO, myOpenPrs: 3, reviewRequests: 2 },
  { host: LEDGER_HOST, name: "finance/payroll", myOpenPrs: 1, reviewRequests: 2 },
  { host: GITHUB_COM, name: "tallyho/fieldbook-docs", myOpenPrs: 2, reviewRequests: 0 },
  { host: GITHUB_COM, name: FIELD_APP, myOpenPrs: 1, reviewRequests: 1 },
  { host: GITHUB_COM, name: "tallyho/infra", myOpenPrs: 0, reviewRequests: 1 },
];

export interface FakeSourceOptions {
  readonly clock: Clock;
  readonly scenario?: FakeScenario;
  /** Show the data set under another repo name (a one-repo scenario). */
  readonly repo?: RepoName;
  /** Let checks finish and PRs merge on their own. Off in tests. */
  readonly live?: boolean;
  /** From "requirement met and checks green" to merged. */
  readonly mergeDelayMs?: number;
  /** The public key the scenario treats as mine (default the fake signer's). */
  readonly myKey?: string;
}

const SETUP_PR = 494;
/** In `join`: Ines approved this one on GitHub, which fills its peer slot. */
const JOIN_APPROVED = 485;
const ENROL_PR = 501;
const SECOND = 1000;

export const FAKE_ACCOUNT: Account = {
  login: FAKE_ME,
  name: FAKE_PEOPLE.mara.name,
  scopes: ["repo", "read:org", "workflow"],
};

type SetupState = SetupStatus["state"];

const hostInfo = (host: string): GitHubInfo => {
  const { name, webUrl } = githubHost(host);
  return { host: name, webUrl };
};

/** My login on a host: a managed user's on the fake's GHE.com host, else the github.com one. */
const loginOn = (host: string): string =>
  githubHost(host).name === LEDGER_HOST ? FAKE_PEOPLE_ACME.mara.login : FAKE_ME;

/** One repo of the fake: its PRs, its setup and the keys it trusts. */
class FakeRepo {
  readonly key: RepoKey;
  readonly github: GitHubInfo;
  /** My login on its host. */
  readonly login: string;
  facts: PrFacts[] = [];
  unclassified: Omit<UnclassifiedPr, "repo">[] = [];
  setupPr: PrLink | null = null;
  /** By `publicKeyId`: the key, not its comment. */
  readonly enrolments = new Map<string, Enrolment>();

  constructor(
    readonly name: RepoName,
    host: string,
    public setupState: SetupState,
    /** A set-up repo's step: `enforced` or `shared-policy`. */
    readonly setUpStep: LadderStep,
    readonly permission: RepoPermission,
  ) {
    this.github = hostInfo(host);
    this.key = repoKey(this.github.host, name);
    this.login = loginOn(host);
  }

  get ref(): SourceRepo {
    return { key: this.key, name: this.name, github: this.github, login: this.login };
  }

  url(n: number) {
    return prUrl(this.name, n, this.github.webUrl);
  }

  enrolment(publicKey: string): Enrolment {
    return this.enrolments.get(publicKeyId(publicKey)) ?? { state: "not-enrolled" };
  }

  index(pr: number) {
    return this.facts.findIndex((f) => f.number === pr);
  }
}

export class FakeSource implements Source {
  private readonly clock: Clock;
  private readonly mergeDelayMs: number;
  private readonly started: number;
  private list: FakeRepo[] = [];
  private readonly listeners = new Set<(change: SourceChange) => void>();
  private readonly timers: Timer[] = [];
  private syncAt: number;
  private comments = 0;
  /** The `publicKeyId` of the key the scenario treats as mine. */
  private readonly myKey: string;
  readonly repoList: RepoList;
  /** Resolves once the scenario's PRs are in (the inbox step classifies them first). */
  readonly ready: Promise<void>;

  constructor(options: FakeSourceOptions) {
    const scenario = options.scenario ?? "team";
    this.clock = options.clock;
    this.mergeDelayMs = options.mergeDelayMs ?? 4 * SECOND;
    this.started = this.clock.now();
    this.syncAt = this.started;
    this.myKey = publicKeyId(options.myKey ?? FAKE_KEY.publicKey);
    const name = options.repo ?? FAKE_REPO;
    const pending: Promise<void>[] = [];
    this.repoList = scenario === "dir" ? "fixed" : "managed";

    if (scenario === "repos") {
      const fieldbook = this.team(name, GITHUB_COM, "enforced", "admin");
      fieldbook.enrolments.set(this.myKey, { state: "active" });
      const app = this.inbox(FIELD_APP, pending);
      const ledger = new FakeRepo(LEDGER, LEDGER_HOST, "ready", "shared-policy", "admin");
      ledger.facts = LEDGER_SEEDS.map((s) =>
        seedFacts(s, this.started, LEDGER, ledger.github.webUrl, FAKE_PEOPLE_ACME),
      );
      ledger.enrolments.set(this.myKey, { state: "active" });
      this.list = [fieldbook, app, ledger];
    } else if (scenario === "fresh") {
      if (options.repo)
        this.list = [new FakeRepo(name, GITHUB_COM, "missing", "enforced", "admin")];
    } else if (scenario === "inbox") {
      this.list = [this.inbox(name, pending)];
    } else if (scenario === "first-run") {
      const repo = new FakeRepo(name, GITHUB_COM, "pending", "enforced", "admin");
      repo.setupPr = { number: SETUP_PR, url: repo.url(SETUP_PR) };
      repo.enrolments.set(this.myKey, { state: "pending", pr: repo.setupPr });
      repo.unclassified = UNCLASSIFIED_TITLES.map((title, i) => {
        const number = SEEDS.filter((s) => s.state === "open")[i]?.n ?? 470 + i;
        return { number, title, url: repo.url(number) };
      });
      this.list = [repo];
    } else {
      const repo = this.team(
        name,
        GITHUB_COM,
        scenario === "shared" ? "shared-policy" : "enforced",
        scenario === "join" ? "write" : "admin",
      );
      // A teammate who joins without a key sees a slot a GitHub approval filled (ADR 0006).
      if (scenario === "join")
        repo.facts = repo.facts.map((f) =>
          f.number === JOIN_APPROVED
            ? this.withApproval(
                f,
                FAKE_ME,
                FAKE_PEOPLE.ines.login,
                f.headSha,
                this.started - 2 * 60 * SECOND,
              )
            : f,
        );
      else repo.enrolments.set(this.myKey, { state: "active" });
      if (scenario === "clear") repo.facts = repo.facts.map((f) => this.alreadyDone(f));
      this.list = [repo];
    }
    this.ready = Promise.all(pending).then(() => {});

    if (options.live && this.list[0]) this.startLife(this.list[0]);
    // Time-dependent fields (stuck after 12 h) move without anything happening.
    this.timers.push(this.clock.every(60 * SECOND, () => this.emit("prs")));
  }

  /** The mockup's repo, set up. */
  private team(name: RepoName, host: string, step: LadderStep, permission: RepoPermission) {
    const repo = new FakeRepo(name, host, "ready", step, permission);
    repo.facts = SEEDS.map((s) => seedFacts(s, this.started, name, repo.github.webUrl));
    return repo;
  }

  /** A repo at the inbox step: its PRs are classified first (`ready`). */
  private inbox(name: RepoName, pending: Promise<void>[]) {
    const repo = new FakeRepo(name, GITHUB_COM, "missing", "enforced", "admin");
    pending.push(
      inboxFacts(this.started, name).then((facts) => {
        if (!this.list.includes(repo)) return;
        repo.facts = facts;
        this.emit("prs");
      }),
    );
    return repo;
  }

  // -- Source ---------------------------------------------------------------

  async account(): Promise<Account | null> {
    return FAKE_ACCOUNT;
  }

  gh(): GhLogin {
    return {
      host: this.list[0]?.github.host ?? GITHUB_COM,
      state: "signed-in",
      path: "/usr/bin/gh",
      detail: null,
      checkedAt: this.clock.now(),
      service: false,
    };
  }

  repos(): ReadonlyArray<SourceRepo> {
    return this.list.map((r) => r.ref);
  }

  async addRepo(input: string): Promise<SourceRepo> {
    const parsed = parseRepoInput(input);
    if (!parsed) throw new SourceError("bad-request", `${input} is not a repository.`);
    const known = this.list.find((r) => sameRepo(r.key, parsed.key));
    if (known) return known.ref;
    if (/missing/i.test(parsed.name))
      throw new SourceError(
        "not-found",
        `${parsed.key} does not exist, or ${loginOn(parsed.host)} on ${parsed.host} cannot see it.`,
      );
    if (/private/i.test(parsed.name))
      throw new SourceError(
        "forbidden",
        `${loginOn(parsed.host)} on ${parsed.host} cannot read ${parsed.key}: ask for read access.`,
      );
    // A repo nod has not read yet: the inbox step, nothing of nod in it, no PRs in the fake.
    const repo = new FakeRepo(parsed.name, parsed.host, "missing", "enforced", "admin");
    this.list = [...this.list, repo];
    this.emit("repos");
    this.emit("prs");
    return repo.ref;
  }

  async removeRepo(key: RepoKey): Promise<void> {
    const repo = this.repo(key);
    this.list = this.list.filter((r) => r !== repo);
    this.emit("repos");
    this.emit("prs");
  }

  async suggestRepos(): Promise<ReadonlyArray<RepoSuggestion>> {
    return SUGGESTIONS.map((s) => {
      const github = hostInfo(s.host);
      return {
        key: repoKey(github.host, s.name),
        name: s.name,
        github,
        myOpenPrs: s.myOpenPrs,
        reviewRequests: s.reviewRequests,
      };
    })
      .filter((s) => !this.list.some((r) => sameRepo(r.key, s.key)))
      .sort((a, b) => b.myOpenPrs + b.reviewRequests - (a.myOpenPrs + a.reviewRequests));
  }

  snapshot(): Snapshot | null {
    if (this.list.length === 0) return null;
    const acme = this.list.some((r) => r.login !== FAKE_ME);
    const people = [
      ...Object.values(FAKE_PEOPLE),
      ...(acme ? Object.values(FAKE_PEOPLE_ACME) : []),
    ];
    const now = this.clock.now();
    return {
      // The first repo's host's, as `welcome.me`; each repo's views are relative to its own.
      me: this.list[0]!.login,
      people,
      prs: this.list.flatMap((repo) =>
        toViews(repo.facts.map(enforcedIn(repo)), {
          repo: repo.key,
          me: repo.login,
          now,
          people,
          // My key signs only once it is enrolled; until then the asks are approvals.
          signing: repo.enrolments.get(this.myKey)?.state === "active",
        }),
      ),
      unclassified: this.list.flatMap((repo) =>
        repo.unclassified.map((u) => ({ repo: repo.key, ...u })),
      ),
      sync: { at: this.syncAt, error: null },
    };
  }

  async refresh(): Promise<void> {
    this.syncAt = this.clock.now();
    this.emit("prs");
  }

  async signTarget(key: RepoKey, pr: number): Promise<SignTarget | null> {
    const repo = this.repo(key);
    const f = repo.facts.find((x) => x.number === pr);
    return f
      ? {
          repo: repo.key,
          pr,
          state: f.state,
          author: f.author,
          base: f.base,
          headSha: f.headSha,
          patchId: f.patchId,
        }
      : null;
  }

  async postNod(input: PostNodInput): Promise<ReadonlyArray<PostResult>> {
    const { payload } = input;
    const repo = this.repo(input.repo);
    const results: PostResult[] = [];
    for (const entry of payload.entries) {
      const index = repo.index(entry.pr);
      if (index < 0 || !sameLogin(payload.repo, repo.name)) {
        results.push({
          pr: entry.pr,
          ok: false,
          url: null,
          message: `#${entry.pr} is not in ${repo.key}.`,
        });
        continue;
      }
      const f = repo.facts[index]!;
      const url = `${f.url}#issuecomment-${9_000_000 + ++this.comments}`;
      repo.facts[index] = this.withNod(
        f,
        repo.login,
        payload.reviewer,
        entry,
        payload.entries.length,
        url,
      );
      results.push({ pr: entry.pr, ok: true, url, message: null });
      this.whenReady(repo, entry.pr);
    }
    this.emit("prs");
    return results;
  }

  async postApprovals(input: PostApprovalsInput): Promise<ReadonlyArray<PostResult>> {
    const repo = this.repo(input.repo);
    const results: PostResult[] = [];
    for (const entry of input.entries) {
      const index = repo.index(entry.pr);
      if (index < 0) {
        results.push({
          pr: entry.pr,
          ok: false,
          url: null,
          message: `#${entry.pr} is not in ${repo.key}.`,
        });
        continue;
      }
      const f = repo.facts[index]!;
      const url = `${f.url}#pullrequestreview-${8_000_000 + ++this.comments}`;
      repo.facts[index] = this.withApproval(f, repo.login, repo.login, entry.headSha);
      results.push({ pr: entry.pr, ok: true, url, message: null });
      this.whenReady(repo, entry.pr);
    }
    this.emit("prs");
    return results;
  }

  async ackFyi(key: RepoKey, pr: number): Promise<void> {
    const repo = this.repo(key);
    const index = repo.index(pr);
    const f = repo.facts[index];
    if (!f?.fyi) throw new SourceError("not-found", `#${pr} has no FYI.`);
    const me = repo.login;
    if (!f.fyi.pending.some((l) => sameLogin(l, me))) return;
    const at = this.clock.now();
    repo.facts[index] = {
      ...f,
      fyi: {
        ...f.fyi,
        acked: [...f.fyi.acked, me],
        pending: f.fyi.pending.filter((l) => !sameLogin(l, me)),
      },
      journey: [...f.journey, event("fyi-acked", "You got it", at)],
    };
    this.emit("prs");
  }

  async setup(key: RepoKey): Promise<SetupStatus> {
    const repo = this.repo(key);
    return setupStatus(repo.setupState, repo.setupPr, {
      step: repo.setUpStep,
      permission: repo.permission,
    });
  }

  async openSetupPr(key: RepoKey, publicKey: string | null): Promise<PrLink> {
    const repo = this.repo(key);
    if (repo.setupState === "ready")
      throw new SourceError("already-set-up", `${repo.key} is set up already.`);
    if (repo.setupPr) return repo.setupPr;
    // As `nod init`: my key is the first signer if I have one; else nobody is (ADR 0006).
    repo.setupPr = { number: SETUP_PR, url: repo.url(SETUP_PR) };
    repo.setupState = "pending";
    if (publicKey && repo.enrolment(publicKey).state === "not-enrolled")
      repo.enrolments.set(publicKeyId(publicKey), { state: "pending", pr: repo.setupPr });
    this.emit("setup");
    this.emit("enrolment");
    return repo.setupPr;
  }

  async openEnrolPr(key: RepoKey, publicKey: string): Promise<PrLink> {
    const repo = this.repo(key);
    const current = repo.enrolment(publicKey);
    if (current.state === "active")
      throw new SourceError("already-enrolled", "Your key is enrolled already.");
    if (current.state === "pending" && current.pr) return current.pr;
    // As the GitHub source: an open setup PR is not changed; the key gets its PR after the merge.
    if (repo.setupState !== "ready")
      throw new SourceError(
        "github",
        `${repo.key} is not set up yet: the setup PR enrols the first key.`,
      );
    const pr = { number: ENROL_PR, url: repo.url(ENROL_PR) };
    repo.enrolments.set(publicKeyId(publicKey), { state: "pending", pr });
    this.emit("enrolment");
    return pr;
  }

  enrolment(key: RepoKey, publicKey: string): Enrolment {
    return this.repo(key).enrolment(publicKey);
  }

  /**
   * Nothing to do: as with GitHub, a key created after the setup PR opened
   * is not added to it (it gets its own enrolment PR once the setup merged).
   */
  keyCreated(_publicKey: string): void {}

  /** My inbox over the fake (ADR 0009): canned files, diff and history (`inbox/fake-subjects.ts`). */
  async inboxSubject(key: RepoKey, pr: number): Promise<InboxSubject | null> {
    const repo = this.repo(key);
    const f = repo.facts.find((x) => x.number === pr);
    return f ? fakeSubject(repo.name, f, this.clock.now()) : null;
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

  private repo(key: RepoKey): FakeRepo {
    const repo = this.list.find((r) => sameRepo(r.key, key));
    if (!repo) throw new SourceError("not-found", `nod serve does not read ${key}.`);
    return repo;
  }

  private emit(change: SourceChange) {
    for (const listener of this.listeners) listener(change);
  }

  private update(repo: FakeRepo, pr: number, change: (f: PrFacts) => PrFacts) {
    const index = repo.index(pr);
    if (index < 0) return;
    repo.facts[index] = change(repo.facts[index]!);
    this.emit("prs");
  }

  /** A nod as the verifier would count it (ADR 0001, rule 5). */
  private withNod(
    f: PrFacts,
    me: string,
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
    const you = sameLogin(reviewer, me);
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

  /**
   * A GitHub approval as GitHub and the verifier would show it: the review
   * request from me is answered, and a slot that takes approvals is filled.
   */
  private withApproval(
    f: PrFacts,
    me: string,
    reviewer: string,
    headSha: string,
    at = this.clock.now(),
  ): PrFacts {
    const atHead = headSha === f.headSha;
    const review = f.review ?? {
      requested: [],
      teams: [],
      fromMe: false,
      approvedBy: [],
      changesRequestedBy: [],
    };
    const others = (list: ReadonlyArray<string>) => list.filter((l) => !sameLogin(l, reviewer));
    // Asked through my team: my review answers the team's request too.
    const viaTeam = review.fromMe && !review.requested.some((l) => sameLogin(l, reviewer));
    const counts = atHead && !sameLogin(f.author, reviewer);
    const slots = f.requirement.slots.map((s) =>
      counts && !s.nodsOnly && canFill(s, reviewer)
        ? { ...s, state: "ok" as const, signature: null, approval: reviewer }
        : s,
    );
    const you = sameLogin(reviewer, me);
    return {
      ...f,
      review: {
        ...review,
        requested: others(review.requested),
        teams: you && viaTeam ? [] : review.teams,
        fromMe: you ? false : review.fromMe,
        approvedBy: [...others(review.approvedBy), reviewer],
        approvedAtHead: atHead
          ? [...others(review.approvedAtHead ?? []), reviewer]
          : others(review.approvedAtHead ?? []),
        changesRequestedBy: others(review.changesRequestedBy),
      },
      requirement: { ...f.requirement, slots },
      journey: [
        ...f.journey,
        event("reviewed", you ? "You approved" : `${personName(reviewer)} approved`, at),
      ],
      lastActivity: { at, text: you ? "you approved" : `${personName(reviewer)} approved` },
    };
  }

  /** Merge once the requirement is met and the checks are green, in an enforced repo. */
  private whenReady(repo: FakeRepo, pr: number) {
    const f = repo.facts.find((x) => x.number === pr);
    // Before the check is required a person merges, not the agent: nothing happens on its own.
    if (!f || f.state !== "open" || f.classifiedBy === "local") return;
    if (repo.setupState !== "ready" || repo.setUpStep !== "enforced") return;
    if (f.requirement.slots.some((s) => s.state !== "ok")) return;
    if (f.checks.state === "pending" || f.checks.state === "failing") return;
    this.timers.push(this.clock.after(this.mergeDelayMs, () => this.merge(repo, pr)));
  }

  private merge(repo: FakeRepo, pr: number) {
    const at = this.clock.now();
    this.update(repo, pr, (f) =>
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

  private checksDone(repo: FakeRepo, pr: number, text = "checks turned green") {
    const at = this.clock.now();
    this.update(repo, pr, (f) =>
      f.state !== "open"
        ? f
        : {
            ...f,
            checks: { ...f.checks, state: "passing", passed: f.checks.total, failing: [] },
            journey: [...f.journey, event("checks", "Checks green", at)],
            lastActivity: { at, text },
          },
    );
    this.whenReady(repo, pr);
  }

  /** The mockup's repo comes alive: checks finish, a fix is pushed. */
  private startLife(repo: FakeRepo) {
    const at = (s: number, fn: () => void) => this.timers.push(this.clock.after(s * SECOND, fn));
    at(20, () => this.checksDone(repo, 481));
    at(30, () => this.checksDone(repo, 483));
    at(45, () => this.checksDone(repo, 478));
    at(90, () => {
      const now = this.clock.now();
      this.update(repo, 493, (f) => ({
        ...f,
        checks: { ...f.checks, state: "pending", passed: 9, failing: [] },
        journey: [...f.journey, event("pushed", "Fix pushed", now, "by the agent")],
        lastActivity: { at: now, text: "another fix pushed" },
      }));
    });
    at(120, () => this.checksDone(repo, 493));
  }

  /** The `clear` scenario: everything that needed me was nodded an hour ago. */
  private alreadyDone(f: PrFacts): PrFacts {
    const at = this.started - 60 * 60 * SECOND;
    let next = f;
    if (f.state === "open" && f.requirement.slots.some((s) => canFill(s, FAKE_ME))) {
      next = this.withNod(
        f,
        FAKE_ME,
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

/**
 * The requirement's `enforced`, as the verifier's summary says it: whether
 * the repo requires the `nod` check. A PR classified locally has no policy.
 */
const enforcedIn =
  (repo: FakeRepo) =>
  (f: PrFacts): PrFacts =>
    f.classifiedBy === "local" || repo.setupState !== "ready"
      ? f
      : { ...f, requirement: { ...f.requirement, enforced: repo.setUpStep === "enforced" } };

function event(
  kind: JourneyEvent["kind"],
  text: string,
  at: number,
  detail: string | null = null,
): JourneyEvent {
  return { kind, text, detail, at, phase: "done", tone: "plain" };
}

/**
 * The fake's setup checklist. A set-up repo is `enforced` (its required check
 * on) unless `step` says `shared-policy`; I am an admin unless `permission`
 * says otherwise.
 */
export function setupStatus(
  state: SetupState,
  setupPr: PrLink | null,
  options: { readonly step?: LadderStep; readonly permission?: RepoPermission | null } = {},
): SetupStatus {
  const pending = setupPr ? `in #${setupPr.number}` : "pending";
  const enforced = state === "ready" && (options.step ?? "enforced") === "enforced";
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
      state === "ready" && (adds || enforced)
        ? "ok"
        : state === "pending" && adds
          ? "pending"
          : "missing",
    note:
      state === "ready"
        ? adds || enforced
          ? null
          : "run nod init --ruleset"
        : !adds
          ? "after merge"
          : state === "pending"
            ? pending
            : "missing",
  });
  return {
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
    step: state !== "ready" ? "inbox" : enforced ? "enforced" : "shared-policy",
    permission: options.permission === undefined ? "admin" : options.permission,
  };
}

/**
 * The wire contract between `nod serve` and the web app: the messages of the
 * one token-guarded WebSocket. Both halves import from here and nowhere else.
 *
 *   browser (web app, any tab) ──ws://127.0.0.1:4518/ws?token=…──▶ `nod serve`
 *
 * - Every message is one JSON object with a `t` discriminant. Only plain
 *   JSON types: no classes, no `Date`, no `undefined` values. Times are epoch
 *   milliseconds (`number`).
 * - The server pushes state; the client never has to ask twice. On connect it
 *   sends `welcome`, then `snapshot` (when a repo is picked). Afterwards it
 *   pushes a full `snapshot` on every change of the PRs, `signer` on every
 *   change of the signing key (unlock, lock, auto-lock), and `setup` on every
 *   change of the repo's setup. Every open tab gets every push.
 * - The client sends requests. Each carries an `id` the client picks; the
 *   server answers each with exactly one `reply` of the same `id`. A reply's
 *   result is typed by the request (`Requests` below). State changes caused by
 *   a request also arrive as pushes, so a client may ignore the reply's result.
 * - Everything shown on screen is derived from the `snapshot` view model by
 *   the pure functions in `attention.ts`. The view model is already relative
 *   to the user (`me`): `mine`, `needsMe`, `ask`, `fyiForMe`, `waitingOn`.
 */

export const PROTOCOL_VERSION = 1;

/** Where `nod serve` listens unless `--port` says otherwise (loopback only). */
export const DEFAULT_SERVE_PORT = 4518;
/** The Vite dev server of the web app. */
export const DEV_WEB_PORT = 4517;
/** The WebSocket path; the token rides in the query: `/ws?token=…`. */
export const WS_PATH = "/ws";

/**
 * Close codes the server uses (4000–4999 is the application range).
 * A wrong or missing token closes with `CLOSE_BAD_TOKEN` right after the
 * upgrade, so the page can tell "pair again" apart from "server not running"
 * (a refused connection closes with 1006 and no code).
 */
export const CLOSE_BAD_TOKEN = 4401;
/** The server is shutting down (`nod serve` stopped with Ctrl-C). */
export const CLOSE_SHUTDOWN = 4001;

// ---------------------------------------------------------------------------
// people and the repo

/** A GitHub login, compared case-insensitively. */
export type Login = string;

/** `owner/name`, as in the nod payload. */
export type RepoName = string;

export interface Person {
  readonly login: Login;
  /** The display name from GitHub; null when the profile has none. */
  readonly name: string | null;
}

/** The `gh` login `nod serve` runs as (onboarding step 1). */
export interface Account {
  readonly login: Login;
  readonly name: string | null;
  /** The token's scopes, as `gh auth status` lists them. Shown, never widened. */
  readonly scopes: ReadonlyArray<string>;
}

/**
 * The GitHub host `nod serve` reads, from its clone's origin: github.com,
 * `<name>.ghe.com` or a GitHub Enterprise Server. PR and repo links start
 * at `webUrl`.
 */
export interface GitHubInfo {
  /** Lowercase host name, as `gh auth login --hostname` takes it: `github.com`, `acme.ghe.com`. */
  readonly host: string;
  /** The web UI, no trailing slash: `https://acme.ghe.com`. */
  readonly webUrl: string;
}

/** A repo offered in onboarding step 1 (`list-repos`). */
export interface RepoChoice {
  readonly repo: RepoName;
  /** The repo of the folder `nod serve` was started in. */
  readonly current: boolean;
  readonly canWrite: boolean;
  readonly pushedAt: number | null;
}

/** A pull request nod opened itself (the setup PR, an enrolment PR). */
export interface PrLink {
  readonly number: number;
  readonly url: string;
}

// ---------------------------------------------------------------------------
// repo setup (onboarding step 2) and the signing key (steps 3 and 4)

export type CheckState = "ok" | "missing" | "pending" | "unknown";

/** One line of a setup checklist. */
export interface SetupCheck {
  /**
   * `verifier` (`.nod/verify.ts`) and `auto-merge` (the repo setting) come
   * from the GitHub source only; the fake lists the first four.
   */
  readonly id:
    | "policy"
    | "workflow"
    | "allowed-signers"
    | "required-check"
    | "verifier"
    | "auto-merge";
  readonly label: string;
  /** The file or setting it is about, e.g. `.nod/policy.ts`. */
  readonly detail: string;
  readonly state: CheckState;
  /** Short right-hand note: "missing", "after merge", "pending #494". */
  readonly note: string | null;
}

/**
 * The repo's step of the opt-in ladder (ADR 0006), as far as the repo
 * opts in; signing is per person (`SignerState`, `Enrolment`).
 *
 * - `inbox`: no nod setup on the default branch (or not all of it). Only
 *   my `nod serve` knows about nod: it classifies the PRs itself, display
 *   only (`PrView.classifiedBy` `local`), and "needs me" is GitHub's review
 *   requests and my own stuck PRs.
 * - `shared-policy`: `.nod/` and the workflow are on the default branch; the
 *   verifier classifies, and its `nod` check is neutral until enforced.
 * - `enforced`: the default branch requires the `nod` check.
 */
export type LadderStep = "inbox" | "shared-policy" | "enforced";

/**
 * Where the repo stands. `none`: no repo picked yet (step 1). `missing`:
 * the repo has no `.nod/` yet (step 2 offers the setup PR). `pending`: the
 * setup PR is open, nothing is gated yet. `ready`: the verifier runs.
 */
export interface SetupStatus {
  readonly repo: RepoName | null;
  readonly state: "none" | "missing" | "pending" | "ready";
  readonly checks: ReadonlyArray<SetupCheck>;
  /** The open setup PR, once nod opened one. */
  readonly setupPr: PrLink | null;
  /**
   * The repo's ladder step. Per repo, so it carries over to many repos.
   * Added after protocol 1 shipped: read it with `ladderStepOf`, which
   * derives it from `state` for a server that does not send it.
   */
  readonly step?: LadderStep;
}

/** The repo's ladder step; from `state` when the server did not say (`ready` reads `shared-policy`). */
export function ladderStepOf(setup: Pick<SetupStatus, "state" | "step">): LadderStep {
  return setup.step ?? (setup.state === "ready" ? "shared-policy" : "inbox");
}

/**
 * Whether the repo trusts the key (`.nod/allowed_signers` on the base
 * branch, ADR 0002). A pending key can read everything and sign nothing.
 */
export type Enrolment =
  | { readonly state: "active" }
  | { readonly state: "pending"; readonly pr: PrLink | null }
  | { readonly state: "not-enrolled" };

export interface KeyInfo {
  /** `SHA256:…`, as `ssh-keygen -l` prints it. */
  readonly fingerprint: string;
  /** The OpenSSH public key line (`ssh-ed25519 AAAA… comment`). */
  readonly publicKey: string;
  /** Where the encrypted private key lives, for display. */
  readonly location: string;
  readonly enrolment: Enrolment;
}

/**
 * The signing key as the lock chip shows it. `unlocked.until` drives the
 * countdown; the server locks on its own at that time and pushes `signer`.
 * `once`: unlocked for one batch only, locks again after the next `sign`.
 */
export type SignerState =
  | { readonly state: "no-key" }
  | { readonly state: "locked"; readonly key: KeyInfo }
  | {
      readonly state: "unlocked";
      readonly key: KeyInfo;
      readonly until: number;
      readonly once: boolean;
    };

/** Unlock windows the UI offers; the server clamps to [1, MAX_UNLOCK_MINUTES]. */
export const DEFAULT_UNLOCK_MINUTES = 15;
export const MAX_UNLOCK_MINUTES = 60;
/** The shortest passphrase `create-key` accepts, in characters. */
export const MIN_PASSPHRASE_LENGTH = 12;

// ---------------------------------------------------------------------------
// the PR view model

export type Risk = 0 | 1 | 2 | 3;

/** The policy's category: merges on its own, needs a human, or shares knowledge. */
export type Category = "auto" | "decide" | "fyi";

export type PrState = "open" | "draft" | "merged" | "closed";

/**
 * Diff size for the `+312 −88` indicator and its bar. `added`/`removed`/
 * `files` leave out lockfiles and generated files (a dependency bump should
 * not look huge); `excluded` counts what was left out.
 */
export interface DiffStats {
  readonly added: number;
  readonly removed: number;
  readonly files: number;
  readonly excluded: {
    readonly added: number;
    readonly removed: number;
    readonly files: number;
  };
}

/**
 * The repo's CI checks on the head commit, without the `nod` check itself
 * (that one is red until the requirement is met and would say nothing).
 */
export interface Checks {
  readonly state: "none" | "pending" | "passing" | "failing";
  readonly passed: number;
  readonly total: number;
  /** Names of the failing checks. */
  readonly failing: ReadonlyArray<string>;
}

/**
 * The agent's brief from the PR body (template: what, why, risk, how it was
 * verified, where to look). Plain text; `backticks` mark code. null when the
 * PR has no brief.
 */
export interface Brief {
  readonly what: string;
  readonly why: string;
  readonly risk: string;
  readonly verified: string;
  /** Paths or `path (note)` lines. */
  readonly lookAt: ReadonlyArray<string>;
}

/** One classifier fact behind the category and the requirement ("Why this needs you"). */
export interface Reason {
  /** The classifier's id: `module-tier`, `diff-size`, `migration`, … */
  readonly classifier: string;
  readonly fact: string;
  /** What it did: "needs another human", "risk raised to high", "no change". */
  readonly effect: string;
  /** It raised the requirement or the risk (shown with ↑). */
  readonly raises: boolean;
}

/**
 * A signature slot of the requirement. `who` names the person a slot is for
 * (the prompter, a named owner); a peer slot has `who: null` and `except`,
 * the prompter, who cannot fill it.
 */
export interface Slot {
  readonly role: "prompter" | "peer" | "owner";
  /** As the panel shows it: "Prompter", "Peer", "Owner of core/auth". */
  readonly label: string;
  readonly who: Login | null;
  readonly except: Login | null;
  /** `stale`: was signed, but the content changed since (a new nod is needed). */
  readonly state: "missing" | "ok" | "stale";
  /** Index into `PrView.signatures` of the nod that fills it (or filled it, when stale). */
  readonly signature: number | null;
  /**
   * Who filled it with a GitHub approval instead of a nod (ADR 0006); then
   * `state` is `ok` and `signature` null. Absent or null: no approval fills it.
   */
  readonly approval?: Login | null;
  /** Only a nod fills it; a GitHub approval does not (`peer({ approvals: false })`). */
  readonly nodsOnly?: boolean;
}

/** The policy result for the PR's head (read from the verifier's check summary). */
export interface Requirement {
  /** The policy rule that matched, e.g. `tier3-module-change`. */
  readonly policy: string;
  /** "Another human (not the prompter)", "None (auto-merge)". */
  readonly label: string;
  readonly slots: ReadonlyArray<Slot>;
  readonly satisfied: boolean;
  /**
   * Whether the base branch requires the `nod` check (ADR 0006): if not, an
   * unmet requirement blocks nothing (the check is neutral). Absent: unknown,
   * e.g. no verifier summary.
   */
  readonly enforced?: boolean;
}

/** A nod found on the PR, and whether it counts now (ADR 0001, rule 5). */
export interface Signature {
  readonly by: Login;
  readonly byMe: boolean;
  /** From the signature: the reviewer is the PR author (self) or not (peer). */
  readonly level: "self" | "peer";
  readonly at: number;
  readonly headSha: string;
  readonly patchId: string;
  /** What still matches the PR now; null when neither does. */
  readonly matchedBy: "head_sha" | "patch_id" | null;
  readonly counts: boolean;
  /** Why it does not count: "content changed since", "key not enrolled", "base changed". */
  readonly why: string | null;
  /** How many PRs the same signature covers (a batch). */
  readonly batchSize: number;
  readonly commentUrl: string | null;
}

/** The PR's FYI: who should notice it and who has acked. Acks are unsigned. */
export interface Fyi {
  /** "declared by author: test commands change", "policy: core/auth change". */
  readonly reason: string;
  readonly source: "policy" | "declared";
  readonly acked: ReadonlyArray<Login>;
  readonly pending: ReadonlyArray<Login>;
}

/** What is asked of me on this PR: the one button of the row. */
export interface Ask {
  /** `re-attest`: I signed before, the content changed, my nod dropped. */
  readonly kind: "peer" | "owner" | "self" | "re-attest";
  /** "Sign as peer", "Sign as owner of core/auth", "Self-attest", "Re-attest". */
  readonly label: string;
  /**
   * What happens once I sign (the batch dialog's outcome column):
   * the requirement is met and the agent merges, or it still waits.
   */
  readonly then:
    | { readonly outcome: "satisfied" }
    | { readonly outcome: "waits"; readonly on: ReadonlyArray<WaitingOn> };
}

/**
 * Why a PR is stuck: a check fails, it conflicts with its base, a reviewer
 * requested changes, or it has waited on a human for 12 h or more. The first
 * that applies, in that order.
 */
export type Stuck =
  | { readonly reason: "checks-failing"; readonly checks: ReadonlyArray<string> }
  | { readonly reason: "conflict" }
  | { readonly reason: "changes-requested"; readonly by: ReadonlyArray<Login> }
  | { readonly reason: "waiting"; readonly since: number; readonly on: ReadonlyArray<WaitingOn> };

/** The stuck rule's threshold. */
export const STUCK_AFTER_MS = 12 * 60 * 60 * 1000;

/**
 * Who the PR waits on, for the board's "Waiting on" columns. `anyone`: a
 * peer slot I cannot fill (my own PR), any teammate but `except` can. `merge`:
 * nothing is missing, it waits for the agent's auto-merge. `nothing`: merged
 * or closed.
 */
export type WaitingOn =
  | { readonly kind: "me" }
  | { readonly kind: "person"; readonly login: Login }
  | { readonly kind: "anyone"; readonly except: Login }
  | { readonly kind: "checks" }
  | { readonly kind: "agent" }
  | { readonly kind: "merge" }
  | { readonly kind: "nothing" };

/** One step of the PR's journey (the detail panel's timeline). */
export interface JourneyEvent {
  readonly kind:
    | "opened"
    | "pushed"
    | "rebased"
    | "classified"
    | "requested"
    | "nodded"
    | "nod-dropped"
    | "reviewed"
    | "fyi-acked"
    | "checks"
    | "waiting"
    | "merged"
    | "closed";
  /** "Opened", "Jonas signed", "Content changed", "Waiting on you", "Agent merges". */
  readonly text: string;
  /** "needs 2 people", "signature held", "after the request". */
  readonly detail: string | null;
  /** null for an upcoming step. */
  readonly at: number | null;
  /** `now`: where it is; `next`: still to come. */
  readonly phase: "done" | "now" | "next";
  readonly tone: "plain" | "bad";
}

/** A changed file, for the folded "Files" section. */
export interface FileChange {
  readonly path: string;
  readonly added: number;
  readonly removed: number;
  /** The classifier's area: "core", "tier 2", "docs", "core · test". */
  readonly area: string | null;
  /** Left out of `DiffStats`. */
  readonly excluded: "lockfile" | "generated" | null;
}

/**
 * GitHub's own review state of the PR, as anyone sees it on GitHub: who is
 * asked to review, and each reviewer's latest approving or change-requesting
 * review (people with write access only; comments do not count).
 */
export interface Review {
  /** People a review is requested from. */
  readonly requested: ReadonlyArray<Login>;
  /** Teams a review is requested from, `org/team`. */
  readonly teams: ReadonlyArray<string>;
  /** A review is requested from me, directly or through a team I am in. Mentions do not count. */
  readonly fromMe: boolean;
  readonly approvedBy: ReadonlyArray<Login>;
  readonly changesRequestedBy: ReadonlyArray<Login>;
}

/** The newest thing that happened, for the chronological view. */
export interface Activity {
  readonly at: number;
  /** As a row shows it, from my side: "2 new commits", "your signature dropped". */
  readonly text: string;
}

/**
 * Everything a row, a card and the detail panel show about one PR.
 *
 * Not in here, because only the browser knows: whether I opened the PR in
 * the UI (the batch dialog's "not opened" mark), selection, the panel's state.
 */
export interface PrView {
  readonly number: number;
  readonly title: string;
  readonly url: string;
  readonly state: PrState;
  /** The GitHub author. Agents use the human's token, so it is usually the prompter. */
  readonly author: Login;
  /** The human responsible for the change. */
  readonly prompter: Login;
  /** "Claude Code", "Codex", "Renovate"; null when not known. */
  readonly agent: string | null;
  /** The brief's topic or the epic's name, for the panel's header. */
  readonly topic: string | null;
  readonly category: Category;
  readonly risk: Risk;
  /**
   * Who classified it (category, risk, tags, reasons). `verifier`: the
   * repo's policy, from the check summary. `local`: the repo has no policy
   * yet (the `inbox` step), so this `nod serve` ran the kit's built-in
   * classifiers on what GitHub returns: display only, nothing is posted, the
   * requirement has no slots. Absent: `verifier` (or not classified yet).
   */
  readonly classifiedBy?: "verifier" | "local";
  /**
   * Classifier tags, most telling first: "migration", "core", "tier 2",
   * "deps", "docs", "tooling", "security". The first is the row's one tag.
   */
  readonly tags: ReadonlyArray<string>;
  readonly base: string;
  readonly headSha: string;
  /** null until known (computed locally, ADR 0001 rule 6). A PR without one cannot be signed. */
  readonly patchId: string | null;
  readonly openedAt: number;
  readonly mergedAt: number | null;
  readonly diff: DiffStats;
  readonly checks: Checks;
  readonly requirement: Requirement;
  readonly signatures: ReadonlyArray<Signature>;
  readonly reasons: ReadonlyArray<Reason>;
  readonly fyi: Fyi | null;
  readonly brief: Brief | null;
  /** The epic (`Epic: #n` in the brief), for the epic filter. */
  readonly epic: { readonly number: number; readonly title: string } | null;
  /** "needs #492 first": from `Depends on #n` lines and stacked base branches. */
  readonly dependsOn: ReadonlyArray<number>;
  /** "unblocks #482": the reverse of `dependsOn`, across the snapshot. */
  readonly unblocks: ReadonlyArray<number>;
  readonly journey: ReadonlyArray<JourneyEvent>;
  /** null when the server has not loaded the file list. */
  readonly files: ReadonlyArray<FileChange> | null;
  readonly lastActivity: Activity;
  /** GitHub's reviews. Absent from the fake's mockup data set. */
  readonly review?: Review;
  /** GitHub says the head conflicts with the base. Absent: not known. */
  readonly conflict?: boolean;

  // -- relative to me ------------------------------------------------------
  /** I am the prompter. */
  readonly mine: boolean;
  /**
   * The PR is open and wants something of me. Classified by the verifier:
   * the requirement has an open slot I can fill, the same as `ask !== null`.
   * Classified locally (`classifiedBy` `local`): a review is requested from
   * me or a team I am in, or it is mine and stuck (`stuck`: a check failing,
   * a conflict, changes requested); `ask` is then null, there is nothing to sign.
   */
  readonly needsMe: boolean;
  readonly ask: Ask | null;
  /** An FYI I have not acked. */
  readonly fyiForMe: boolean;
  readonly stuck: Stuck | null;
  /** In order: the first entry is the board column. Empty only when nothing is known. */
  readonly waitingOn: ReadonlyArray<WaitingOn>;
  /** Since when it waits on a human; null when it does not. "Oldest waits 5 hours". */
  readonly waitingSince: number | null;
}

/**
 * An open PR the verifier has not classified (first run, or right after a
 * push). With a set-up repo the GitHub source also lists it in `prs`, as a
 * high-risk row with no slots and the tag "not classified" or "verifier
 * error", so it is never folded away as a low-risk change.
 */
export interface UnclassifiedPr {
  readonly number: number;
  readonly title: string;
  readonly url: string;
  /**
   * `pending`: no summary for this head yet (the verifier has not run);
   * `verifier-error`: the verifier ran and failed, or left no readable
   * summary. Absent from the fake source.
   */
  readonly reason?: "pending" | "verifier-error";
}

export interface SyncStatus {
  /** When GitHub was last read successfully; null before the first read. */
  readonly at: number | null;
  /** The last read failed; the snapshot is from `at`. */
  readonly error: string | null;
  /**
   * GitHub is rate-limiting nod: a calm state, not an error. `until` is when
   * it reads again (null when GitHub did not say). Absent when not limited.
   */
  readonly rateLimit?: { readonly until: number | null };
}

/**
 * The full state of the dashboard, pushed on every change. Holds the open
 * PRs and those merged or closed in the last 14 days.
 */
export interface Snapshot {
  readonly repo: RepoName;
  readonly me: Login;
  readonly people: ReadonlyArray<Person>;
  readonly prs: ReadonlyArray<PrView>;
  readonly unclassified: ReadonlyArray<UnclassifiedPr>;
  readonly sync: SyncStatus;
}

// ---------------------------------------------------------------------------
// requests (client → server) and their results

export type Verdict = "approve";

/** One PR of a batch, at the head the user looked at. */
export interface SignEntry {
  readonly pr: number;
  readonly head_sha: string;
}

export interface SignResult {
  /** The exact payload line that was signed (ADR 0001). */
  readonly payload: string;
  /** The PRs the nod comment was posted on, with the comment's URL. */
  readonly posted: ReadonlyArray<{ readonly pr: number; readonly url: string }>;
  /** Posting failed on these; the signature is valid, retrying posts the same comment. */
  readonly failed: ReadonlyArray<{ readonly pr: number; readonly message: string }>;
}

export interface TestSignatureResult {
  readonly payload: string;
  readonly signature: string;
  /** Verified locally against the key's own public half. */
  readonly verified: boolean;
  readonly enrolment: Enrolment;
}

/**
 * Every request, with its body and its result. A request message is
 * `{ t, id, ...body }`; its reply is `{ t: "reply", id, to: t, ok, result | error }`.
 */
export interface Requests {
  /**
   * Decrypt the signing key into the server's memory. `minutes` (default 15,
   * clamped to [1, 60]) is the window before it locks on its own; `once`
   * locks again right after the next `sign` ("this batch only").
   * Errors: `no-key`, `bad-passphrase`, `unlock-pending` (this side's last
   * unlock is still being checked). The passphrase is never logged.
   */
  unlock: {
    body: { readonly passphrase: string; readonly minutes?: number; readonly once?: boolean };
    result: { readonly until: number };
  };
  /** Forget the decrypted key now. Never fails. */
  lock: { body: Record<never, never>; result: Record<never, never> };
  /**
   * Nod a batch. The server checks each entry's `head_sha` against the PR's
   * current head, builds one payload (`repo`, `base`, `head_sha`, `patch_id`
   * per entry, `verdict`, `level: review`, `reviewer: me`, `signed_at`),
   * signs it once and posts the same comment on every PR. All or nothing:
   * if any entry moved since the user looked, nothing is signed and the error
   * is `stale` with `details.stale` listing them, so the dialog can show what
   * changed and the user can re-select. `note` is the comment's free-text
   * human line (not signed). Errors: `locked`, `no-key`, `key-pending`,
   * `stale`, `not-found`, `not-open`, `no-patch-id`, `bad-request`.
   */
  sign: {
    body: {
      readonly entries: ReadonlyArray<SignEntry>;
      readonly verdict: Verdict;
      readonly note?: string;
    };
    result: SignResult;
  };
  /**
   * Mark an FYI as seen ("Got it"): a 👀 reaction on the PR, unsigned; a 👀
   * by anyone is their ack. Errors: `not-found`.
   */
  "ack-fyi": { body: { readonly pr: number }; result: Record<never, never> };
  /**
   * Answer at once and do nothing else: the web app's wake check, to tell a
   * live socket from a half-open one. Any reply proves the socket lives, so
   * a server that predates `ping` answers `bad-request`, which works too:
   * no protocol bump.
   */
  ping: { body: Record<never, never>; result: Record<never, never> };
  /** Read GitHub now instead of waiting for the next poll. A new snapshot follows. */
  refresh: { body: Record<never, never>; result: Record<never, never> };
  /**
   * Onboarding step 1: the `gh` account and the repos to pick from. v1 reads
   * one repo: the GitHub source lists only the clone `nod serve` runs in
   * (`--dir`), and `pick-repo` accepts only that one.
   */
  "list-repos": {
    body: Record<never, never>;
    result: { readonly account: Account; readonly repos: ReadonlyArray<RepoChoice> };
  };
  /**
   * Pick the repo (one per server in v1). The server re-reads the setup,
   * pushes `setup` and then `snapshot`. Errors: `not-found`, `forbidden`.
   */
  "pick-repo": { body: { readonly repo: RepoName }; result: { readonly setup: SetupStatus } };
  /** Onboarding step 2: re-check the repo's setup. Errors: `no-repo`. */
  "check-setup": { body: Record<never, never>; result: { readonly setup: SetupStatus } };
  /**
   * Onboarding step 2: open the one-time setup PR (`.nod/`, the workflow and
   * my public key, when I have one). Errors: `no-repo`, `already-set-up`.
   */
  "open-setup-pr": { body: Record<never, never>; result: { readonly pr: PrLink } };
  /**
   * Onboarding step 3: create a new ed25519 key encrypted with `passphrase`
   * (at least MIN_PASSPHRASE_LENGTH characters). Never replaces a key: that
   * is `nod key create --replace` in a terminal. Adopting the existing
   * private key at `path` is not built (`not-implemented`, ADR 0004). The new
   * state also arrives as a `signer` push. Errors: `key-exists`,
   * `weak-passphrase`, `not-implemented`.
   */
  "create-key": {
    body: { readonly passphrase: string; readonly path?: string };
    result: { readonly key: KeyInfo };
  };
  /**
   * Onboarding step 3, a teammate joining a set-up repo: open the one-line PR
   * that adds my public key to `.nod/allowed_signers`. Errors: `no-key`,
   * `no-repo`, `already-enrolled`.
   */
  "open-enrol-pr": { body: Record<never, never>; result: { readonly pr: PrLink } };
  /**
   * Onboarding step 4: sign a harmless test message and verify it locally.
   * Needs the key unlocked (send `unlock` first). Errors: `locked`, `no-key`.
   */
  "test-signature": { body: Record<never, never>; result: TestSignatureResult };
}

export type RequestType = keyof Requests;
export type RequestBody<K extends RequestType> = Requests[K]["body"];
export type RequestResult<K extends RequestType> = Requests[K]["result"];

export type ClientToServer = {
  [K in RequestType]: { readonly t: K; readonly id: string } & Requests[K]["body"];
}[RequestType];

export type ErrorCode =
  | "bad-request"
  | "no-repo"
  | "no-key"
  | "key-exists"
  | "key-pending"
  | "already-enrolled"
  | "already-set-up"
  | "locked"
  | "bad-passphrase"
  /** An unlock from the same side is still being checked; one at a time per side. */
  | "unlock-pending"
  | "weak-passphrase"
  /** The key file is damaged, of a newer version, or changed while nod serve ran. */
  | "bad-key-file"
  | "stale"
  | "not-found"
  | "not-open"
  | "no-patch-id"
  | "forbidden"
  | "not-implemented"
  | "github"
  | "internal";

export interface RequestError {
  readonly code: ErrorCode;
  /** One sentence for the user. */
  readonly message: string;
  /** `stale`: the entries whose head moved since the user looked. */
  readonly details?: {
    readonly stale?: ReadonlyArray<{
      readonly pr: number;
      readonly signed: string;
      readonly current: string;
    }>;
  };
}

export type Reply = {
  [K in RequestType]:
    | {
        readonly t: "reply";
        readonly id: string;
        readonly to: K;
        readonly ok: true;
        readonly result: Requests[K]["result"];
      }
    | {
        readonly t: "reply";
        readonly id: string;
        readonly to: K;
        readonly ok: false;
        readonly error: RequestError;
      };
}[RequestType];

// ---------------------------------------------------------------------------
// pushes (server → client)

export interface Welcome {
  readonly t: "welcome";
  readonly protocol: typeof PROTOCOL_VERSION;
  /** The published version `nod serve` runs as; null for a checkout. */
  readonly version: string | null;
  /** Serving the in-memory fake data set (`nod serve --fake`), not GitHub. */
  readonly fake: boolean;
  /** The `gh` account; null when `gh` is not logged in (onboarding step 1 says so). */
  readonly me: Account | null;
  readonly repo: RepoName | null;
  /**
   * The GitHub host `repo` is on. Added after protocol 1 shipped: a server
   * that does not send it reads github.com.
   */
  readonly github?: GitHubInfo;
  readonly setup: SetupStatus;
  readonly signer: SignerState;
}

export type ServerToClient =
  | Welcome
  | ({ readonly t: "snapshot" } & Snapshot)
  | { readonly t: "signer"; readonly signer: SignerState }
  | { readonly t: "setup"; readonly setup: SetupStatus }
  | Reply
  /** Not caused by a request: a failed poll, a failed auto-merge watch, … */
  | { readonly t: "error"; readonly code: ErrorCode; readonly message: string };

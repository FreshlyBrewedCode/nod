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
 *   sends `welcome`, then `snapshot` (when it reads a repo). Afterwards it
 *   pushes a full `snapshot` on every change of the PRs, `signer` on every
 *   change of the signing key (unlock, lock, auto-lock), and `repos` on every
 *   change of a repo's setup, my enrolment there, or the list itself (a repo
 *   added or removed: `repos` first, then the `snapshot`). Every open tab gets
 *   every push. `app` (ADR 0008) carries the version, the channel, updates and
 *   the background service, on every change, as the tab's side sees it.
 * - Many repos (ADR 0007): `welcome.repos` lists them, each PR carries its
 *   repo key (`owner/name` on github.com, `host/owner/name` elsewhere), and a
 *   PR is (repo, number) in every request.
 * - The client sends requests. Each carries an `id` the client picks; the
 *   server answers each with exactly one `reply` of the same `id`. A reply's
 *   result is typed by the request (`Requests` below). State changes caused by
 *   a request also arrive as pushes, so a client may ignore the reply's result;
 *   a `repos` push a request caused arrives before its reply.
 * - Everything shown on screen is derived from the `snapshot` view model by
 *   the pure functions in `attention.ts`. The view model is already relative
 *   to the user (`me`): `mine`, `needsMe`, `ask`, `fyiForMe`, `waitingOn`.
 * - Additions stay inside a version: a new optional field or a new push,
 *   which an older page ignores. The version moves only when a field changes
 *   its meaning or goes away (ADR 0007, 7).
 * - The personal layer (ADR 0009, "your own inbox"): each PR may carry
 *   `personal` and `insights`; `welcome.inbox` and the `inbox` push say what
 *   my inbox loaded, and an `insights` push replaces one PR's insights as
 *   analyzers start and finish, so a result needs no full snapshot.
 */

import type { PrId, RepoKey } from "./repo-key";

export type { PrId, RepoKey };

// The personal layer's plain-JSON types (ADR 0009), from the kit's pure
// modules by path: type-only, so the web app imports no kit code.
import type { InsightState, Origin, PersonalAttention } from "../kit/inbox/types.ts";
export type {
  AttentionMark,
  AttentionValue,
  InsightState,
  NamedMark,
  Origin,
  PersonalAttention,
} from "../kit/inbox/types.ts";
export type {
  Block,
  BreakdownBlock,
  BreakdownItem,
  FileItem,
  FilesBlock,
  Insight,
  PrRef as InsightPrRef,
  SeriesBlock,
  SeriesPoint,
  Stat,
  StatsBlock,
  TextBlock,
  Tone,
} from "../kit/inbox/blocks.ts";

/** 2: many repos (ADR 0007). */
export const PROTOCOL_VERSION = 2;

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

/** `owner/name`, as in the nod payload; without the host (that is `RepoKey`). */
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
 * What `nod serve` itself sees of `gh` and its login, on the account's host
 * (the first repo's; github.com without a repo). It is this process's view:
 * a service has its own environment, which may differ from the terminal's.
 * While it is not `signed-in`, nod serve checks again by itself (every
 * {@link GH_RETRY_MS}) and pushes `account` when it changes.
 */
export interface GhLogin {
  /** Lowercase host name, as `gh auth login --hostname` takes it. */
  readonly host: string;
  /**
   * `signed-in`: the account is read. `no-gh`: no `gh` on nod serve's PATH.
   * `signed-out`: `gh` has no login for the host (or GitHub refused its
   * token). `unreachable`: `gh` has a login, GitHub did not answer (yet).
   */
  readonly state: "signed-in" | "no-gh" | "signed-out" | "unreachable";
  /** The `gh` nod serve runs, absolute; null when it finds none. */
  readonly path: string | null;
  /** Why, in one line from `gh` or GitHub (never a token); null when signed in. */
  readonly detail: string | null;
  /** When it was last checked (ms since the epoch); null: not yet. */
  readonly checkedAt: number | null;
  /** This nod serve runs as the background service (`nod service install`). */
  readonly service: boolean;
}

/** How often nod serve asks `gh` and GitHub again while it is not signed in. */
export const GH_RETRY_MS = 15_000;

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
 * Where a repo stands. `missing`: the repo has no `.nod/` yet (the shared
 * policy is offered: the setup PR). `pending`: the setup PR is open, nothing
 * is gated yet. `ready`: the verifier runs.
 */
export interface SetupStatus {
  readonly state: "missing" | "pending" | "ready";
  readonly checks: ReadonlyArray<SetupCheck>;
  /** The open setup PR, once nod opened one. */
  readonly setupPr: PrLink | null;
  /** The repo's ladder step. */
  readonly step: LadderStep;
  /**
   * What I may do in the repo, as GitHub says (`viewerPermission`; `maintain`
   * reads as `write`, `triage` as `read`): the setup PR needs `write`,
   * `nod init --ruleset` needs `admin`. null: unknown.
   */
  readonly permission: RepoPermission | null;
}

export type RepoPermission = "admin" | "write" | "read";

/**
 * Whether the repo trusts the key (`.nod/allowed_signers` on the base
 * branch, ADR 0002). A pending key can read everything and sign nothing.
 */
export type Enrolment =
  | { readonly state: "active" }
  | { readonly state: "pending"; readonly pr: PrLink | null }
  | { readonly state: "not-enrolled" };

/** My one signing key, for every repo; its enrolment is per repo (`RepoInfo.enrolment`). */
export interface KeyInfo {
  /** `SHA256:…`, as `ssh-keygen -l` prints it. */
  readonly fingerprint: string;
  /** The OpenSSH public key line (`ssh-ed25519 AAAA… comment`). */
  readonly publicKey: string;
  /** Where the encrypted private key lives, for display. */
  readonly location: string;
}

/**
 * A repo `nod serve` reads (ADR 0007): its identity, its host, where it
 * stands on the ladder and whether it trusts my key. In the server's order:
 * the inbox's, where one is needed (the offer card, the setup page).
 */
export interface RepoInfo {
  /** The repo key: `owner/name` on github.com, `host/owner/name` elsewhere. Also how it is named on screen. */
  readonly key: RepoKey;
  /** `owner/name`, as in the nod payload and in GitHub's URLs. */
  readonly name: RepoName;
  /** The GitHub host it is on; PR and repo links start at its `webUrl`. */
  readonly github: GitHubInfo;
  /**
   * My login on the repo's host (ADR 0007, 8): logins can differ between
   * hosts (a managed user on GHE.com is `mara_acme`), and what is "mine" in
   * the repo, a nod's `reviewer` and "your own PR" go by this one. null while
   * the host has not been read, or `gh` is not logged in there. Added within
   * protocol 2: without it, `welcome.me` is meant.
   */
  readonly login?: Login | null;
  readonly setup: SetupStatus;
  /**
   * Whether the repo trusts my key (its `.nod/allowed_signers` on the base
   * branch, ADR 0002): each repo is its own trust root. null: no key yet.
   */
  readonly enrolment: Enrolment | null;
}

/**
 * Whether the web app may change the repo list (ADR 0007, 2). `managed`: the
 * list in nod's config file, changed from settings (`add-repo`, `remove-repo`)
 * and `nod repo`; it may be empty. `fixed`: `nod serve --dir <clone>` reads
 * that one clone and never writes the list; settings shows it read-only.
 */
export type RepoList = "managed" | "fixed";

/**
 * A repo worth adding (`suggest-repos`): one where I have open pull requests
 * or review requests, found by one search per host. Never one already read.
 */
export interface RepoSuggestion {
  readonly key: RepoKey;
  readonly name: RepoName;
  readonly github: GitHubInfo;
  /** My open pull requests there. */
  readonly myOpenPrs: number;
  /** Open pull requests there that request a review from me or a team I am in. */
  readonly reviewRequests: number;
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

/**
 * What is asked of me on this PR: the one button of the row.
 *
 * With an active enrolled key (ADR 0002) it is a nod: `peer`, `owner`,
 * `self` or `re-attest`. Without one (no key, a pending or a not enrolled
 * one) it is `approve`, a native GitHub approval (ADR 0006): at the inbox
 * step when a review is requested from me or my team, at a set-up repo when
 * a slot I could fill takes approvals. Never on my own PR: GitHub refuses
 * that, and it is what a nod adds.
 */
export interface Ask {
  /** `re-attest`: I signed before, the content changed, my nod dropped. `approve`: a GitHub approval, no key. */
  readonly kind: "peer" | "owner" | "self" | "re-attest" | "approve";
  /** "Sign as peer", "Sign as owner of core/auth", "Self-attest", "Re-attest", "Approve". */
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
  /**
   * Of `approvedBy`, those whose approval is at the PR's head now: one given
   * before the last push does not count (ADR 0006). Absent: not known.
   */
  readonly approvedAtHead?: ReadonlyArray<Login>;
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
  /** The repo key of the PR's repo (`RepoInfo.key`): a PR is (repo, number). */
  readonly repo: RepoKey;
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
  /**
   * "needs #492 first": from `Depends on #n` lines and stacked base branches.
   * Numbers in the PR's own repo: neither can name another repo's PR.
   */
  readonly dependsOn: ReadonlyArray<number>;
  /** "unblocks #482": the reverse of `dependsOn`, across the repo's PRs. */
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
   * the requirement has an open slot I can fill now (by a nod, or by an
   * approval without a key), the same as `ask !== null`.
   * Classified locally (`classifiedBy` `local`): a review is requested from
   * me or a team I am in (the ask is `approve`), or it is mine and stuck
   * (`stuck`: a check failing, a conflict, changes requested; no ask).
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

  // -- my own inbox (the personal layer, ADR 0009) ---------------------------
  /**
   * What my inbox's attention classifiers say: an adjustment (`1` up a tier,
   * `-1` down one, `"mute"` into Background, `0`), tags, `fyi`, and every
   * mark with its classifier. Kept apart from `risk` and `requirement`,
   * which it never changes; `attention.ts` applies it to the tier. Absent:
   * no inbox ran on it (yet, or it is not open).
   */
  readonly personal?: PersonalAttention;
  /**
   * One state per analyzer of my inbox that applies to it, in the inbox's
   * order: `ready` (with the insight), `empty` (hidden), `running` or
   * `failed`, each labelled `default` or `yours`. `when: "open"` analyzers
   * appear once `open-insights` asked for them. Later states arrive as
   * `insights` pushes. Absent: none yet.
   */
  readonly insights?: ReadonlyArray<InsightState>;
}

/**
 * An open PR the verifier has not classified (first run, or right after a
 * push). With a set-up repo the GitHub source also lists it in `prs`, as a
 * high-risk row with no slots and the tag "not classified" or "verifier
 * error", so it is never folded away as a low-risk change.
 */
export interface UnclassifiedPr {
  readonly repo: RepoKey;
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
 * The full state of the dashboard, pushed on every change. Holds every
 * repo's open PRs and those merged or closed in the last 14 days; each PR
 * names its repo.
 */
export interface Snapshot {
  readonly me: Login;
  readonly people: ReadonlyArray<Person>;
  readonly prs: ReadonlyArray<PrView>;
  readonly unclassified: ReadonlyArray<UnclassifiedPr>;
  /** Of every repo (and host) together: the oldest read, a failing host's message. */
  readonly sync: SyncStatus;
}

// ---------------------------------------------------------------------------
// the app: version, updates, channel, the background service (ADR 0008 §8, §9, §12)

/** The release channel: `stable` follows npm's `latest`, `next` every merge to main. */
export type UpdateChannel = "stable" | "next";

/** A release, as Settings → Server shows it. */
export interface ReleaseView {
  /** Semver without a leading `v`: `0.4.0-next.2`. */
  readonly version: string;
  readonly publishedAt: number;
  /** The release notes: markdown, of which the web app renders a limited subset as text (never HTML). */
  readonly notes: string;
  /** The release's page on GitHub. */
  readonly url: string;
  readonly prerelease: boolean;
}

/** The install the user started with a click. */
export interface InstallView {
  readonly status: "idle" | "installing" | "installed" | "failed";
  /** The version being or last installed. */
  readonly version: string | null;
  /** The tail of the package manager's output, once it finished. */
  readonly output: string | null;
  readonly error: string | null;
  readonly startedAt: number | null;
  readonly finishedAt: number | null;
}

/**
 * What happens after an install succeeded. `restarting`: this `nod serve` is
 * the background service, which restarts it (the app reconnects to the new
 * version). `restart-by-hand`: a plain `nod serve` cannot restart itself;
 * `command` starts it again. `restart-failed`: the service did not restart.
 */
export type AfterInstall =
  | { readonly state: "restarting" }
  | { readonly state: "restart-by-hand"; readonly command: string }
  | { readonly state: "restart-failed"; readonly error: string };

/** Is there an update? From the server's check of GitHub Releases. */
export interface UpdateView {
  readonly status: "idle" | "checking" | "up-to-date" | "available" | "error";
  /** The newest release of the channel, from the last check that answered. */
  readonly latest: ReleaseView | null;
  /** Set exactly when `latest` differs from the running version; `downgrade` after a switch to stable. */
  readonly kind: "upgrade" | "downgrade" | null;
  readonly checkedAt: number | null;
  readonly nextCheckAt: number | null;
  readonly error: string | null;
  readonly installation: InstallView;
  readonly after: AfterInstall | null;
}

/** How nod was installed, and the command that installs the update the same way. */
export interface InstallMethodView {
  /** null: nod does not know (a checkout, `bunx`, Windows); it then installs nothing itself. */
  readonly method: "npm" | "bun" | "pnpm" | "yarn" | null;
  /** The command for the update on offer (or the channel's dist-tag); null when the method is unknown. */
  readonly command: string | null;
  /** With an unknown method: the commands for the usual package managers, to run by hand. */
  readonly commands: ReadonlyArray<string>;
}

/** The background service (`nod service`, ADR 0008 §8). */
export interface ServiceView {
  /** `unknown`: not read yet, or reading it failed. */
  readonly state: "unsupported" | "not-installed" | "stopped" | "running" | "unknown";
  readonly manager: "systemd" | "launchd" | "fake" | "unsupported";
  /** The unit file or the plist, once installed. */
  readonly unitPath: string | null;
  /** The command the service runs, as one line. */
  readonly command: string | null;
  /** This `nod serve` is the service (so an update restarts through it). */
  readonly thisNod: boolean;
  /** The flags "Run nod in the background" sets the service up with: this `nod serve`'s own. */
  readonly args: ReadonlyArray<string>;
  /** Where its output goes: a command (`journalctl …`) or a file. */
  readonly logs: string | null;
  readonly busy: "installing" | "uninstalling" | null;
  readonly error: string | null;
  /** The service was just set up from a plain `nod serve`, which stops now so the service takes the port. */
  readonly handOver: boolean;
}

/**
 * The app's state (Settings → Server, the update indicator): pushed as `app`
 * on every change, per side. `mayChange`: this side may change the machine
 * (install, channel, service), which only this machine's own side may
 * (loopback, ADR 0008 §12); the other device's side reads it.
 */
export interface AppState {
  /** The running version; null in a checkout (a development build). */
  readonly version: string | null;
  readonly development: boolean;
  readonly channel: UpdateChannel;
  readonly update: UpdateView;
  readonly install: InstallMethodView;
  readonly service: ServiceView;
  readonly mayChange: boolean;
  /** `--allow-host`'s origin, when another device can reach this `nod serve`. */
  readonly otherDevice: { readonly origin: string } | null;
}

/** The other device's link as a QR code: rows of `1` (dark) and `0`, without a quiet zone. */
export interface DeviceLink {
  readonly origin: string;
  readonly qr: ReadonlyArray<string>;
}

// ---------------------------------------------------------------------------
// requests (client → server) and their results

export type Verdict = "approve";

/** A PR, wherever it is: its repo key and its number. */
export interface PrRef {
  readonly repo: RepoKey;
  readonly pr: number;
}

/** One PR of a batch, at the head the user looked at. */
export interface SignEntry extends PrRef {
  readonly head_sha: string;
}

export interface SignResult {
  /**
   * The exact payload line signed for each repo of the batch (ADR 0001): a
   * payload names one repo, so a batch across repos is one signature per repo.
   */
  readonly payloads: ReadonlyArray<{ readonly repo: RepoKey; readonly payload: string }>;
  /** The PRs the nod comment was posted on, with the comment's URL. */
  readonly posted: ReadonlyArray<PrRef & { readonly url: string }>;
  /** Posting failed on these; the signature is valid, retrying signs and posts them again. */
  readonly failed: ReadonlyArray<PrRef & { readonly message: string }>;
}

/** What `approve` did: the review on each PR, or why posting it failed. */
export interface ApproveResult {
  /** The PRs approved, with the review's URL. */
  readonly posted: ReadonlyArray<PrRef & { readonly url: string }>;
  /** GitHub refused or did not answer on these; nothing was approved there, retrying is safe. */
  readonly failed: ReadonlyArray<PrRef & { readonly message: string }>;
}

/** The test signature: not a nod, it counts nowhere; my enrolment is per repo (`RepoInfo`). */
export interface TestSignatureResult {
  readonly payload: string;
  readonly signature: string;
  /** Verified locally against the key's own public half. */
  readonly verified: boolean;
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
   * Nod a batch, which may span repos. The server checks each entry's
   * `head_sha` against the PR's current head, builds one payload per repo
   * (`repo`, `base`, `head_sha`, `patch_id` per entry, `verdict`, `level:
   * review`, `reviewer: me`, `signed_at`), signs them in one go and posts
   * each repo's comment on that repo's PRs. All or nothing, across repos:
   * my key must be enrolled in every repo of the batch, and if any entry
   * moved since the user looked, nothing is signed and the error is `stale`
   * with `details.stale` listing them, so the dialog can show what changed
   * and the user can re-select. `note` is the comment's free-text human line
   * (not signed). Errors: `locked`, `no-key`, `key-pending`, `stale`,
   * `not-found`, `not-open`, `no-patch-id`, `bad-request`.
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
   * Approve a batch on GitHub, without a key (ADR 0006): for each entry an
   * `APPROVED` review at the head the user looked at (`commit_id`), as `gh pr
   * review --approve` does, each on its repo's host; a batch may span repos.
   * The same all-or-nothing check as `sign`: if any entry moved since the
   * user looked, nothing is approved and the error is `stale` with
   * `details.stale`. No passphrase, no unlock. `note` is the review's text
   * (none by default). Errors: `stale`,
   * `not-found`, `not-open` (drafts too), `forbidden` (my own PR: GitHub
   * refuses it), `bad-request`.
   */
  approve: {
    body: { readonly entries: ReadonlyArray<SignEntry>; readonly note?: string };
    result: ApproveResult;
  };
  /**
   * Mark an FYI as seen ("Got it"): a 👀 reaction on the PR, unsigned; a 👀
   * by anyone is their ack. Errors: `not-found`.
   */
  "ack-fyi": { body: PrRef; result: Record<never, never> };
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
   * Add a repo to the list (`managed` only). `repo` is what the person typed
   * or pasted: `owner/name` (github.com), `host/owner/name`, or a GitHub URL
   * of the repo or anything in it (`parseRepoInput`). The server checks that
   * the account can read it, adds it, pushes `repos` and then `snapshot`, and
   * answers with the repo as the list now has it. Adding a repo the list has
   * already answers with it and changes nothing. Errors: `bad-request` (not a
   * repo name or link), `not-found` (no such repo, or not visible to the
   * account), `forbidden` (a `fixed` list, or the host's `gh` login cannot
   * read it), `github`.
   */
  "add-repo": { body: { readonly repo: string }; result: { readonly repo: RepoInfo } };
  /**
   * Stop reading a repo (`managed` only): nothing changes in the repository,
   * its clone is a cache. Pushes `repos`, then `snapshot`. Removing the last
   * one leaves an empty list. Errors: `not-found`, `forbidden` (a `fixed` list).
   */
  "remove-repo": { body: RepoBody; result: Record<never, never> };
  /**
   * Repos worth adding: where I have open pull requests or review requests,
   * on every host the list has (github.com when it is empty), the busiest
   * first, without those already read. May be empty. Errors: `github`.
   */
  "suggest-repos": {
    body: Record<never, never>;
    result: { readonly suggestions: ReadonlyArray<RepoSuggestion> };
  };
  /** The shared policy: re-check a repo's setup. Errors: `not-found`. */
  "check-setup": { body: RepoBody; result: { readonly setup: SetupStatus } };
  /**
   * The shared policy: open a repo's one-time setup PR (`.nod/`, the workflow
   * and my public key, when I have one). Errors: `not-found`, `already-set-up`.
   */
  "open-setup-pr": { body: RepoBody; result: { readonly pr: PrLink } };
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
   * Signing, a teammate joining a set-up repo: open the one-line PR that adds
   * my public key to that repo's `.nod/allowed_signers`. Errors: `no-key`,
   * `not-found`, `already-enrolled`.
   */
  "open-enrol-pr": { body: RepoBody; result: { readonly pr: PrLink } };
  /**
   * Onboarding step 4: sign a harmless test message and verify it locally.
   * Needs the key unlocked (send `unlock` first). Errors: `locked`, `no-key`.
   */
  "test-signature": { body: Record<never, never>; result: TestSignatureResult };
  /**
   * The app (ADR 0008 §9): check GitHub Releases now. Resolves once the check
   * ended; the state arrives as an `app` push. Never fails for a failed check
   * (that is `update.status` `error`). Either side.
   */
  "check-update": { body: Record<never, never>; result: Record<never, never> };
  /**
   * Pick the release channel and check it at once. It installs nothing: an
   * update it offers takes a click (`install-update`). This side only
   * (loopback). Errors: `forbidden` (the other device's side).
   */
  "set-channel": { body: { readonly channel: UpdateChannel }; result: Record<never, never> };
  /**
   * Install the update on offer, the version the user saw (`version`), with
   * the package manager nod came with. Answers once it started; the progress
   * arrives as `app` pushes. Loopback only. Errors: `forbidden` (the other
   * device's side), `stale` (the offer changed since), `not-found` (no update
   * on offer), `not-implemented` (nod does not know how it was installed).
   */
  "install-update": { body: { readonly version: string }; result: Record<never, never> };
  /**
   * Run `nod serve` in the background with this `nod serve`'s flags
   * (`service.args`). A plain `nod serve` then stops (`service.handOver`) so
   * the service takes the port. Loopback only. Errors: `forbidden`,
   * `not-implemented` (no service on this system), `service`.
   */
  "service-install": { body: Record<never, never>; result: Record<never, never> };
  /** Stop and remove the background service. Loopback only. Errors: `forbidden`, `not-implemented`, `service`. */
  "service-uninstall": { body: Record<never, never>; result: Record<never, never> };
  /**
   * The other device's link (`--allow-host`) as a QR code. It carries the
   * remote token, so only this machine's side gets it. Errors: `forbidden`
   * (the other device's side), `not-found` (no `--allow-host`).
   */
  "device-link": { body: Record<never, never>; result: DeviceLink };
  /**
   * Ask `gh` and GitHub again now, for the sign-in page's "Try again" (nod
   * serve also does by itself). Resolves with what it found; a change also
   * arrives as an `account` push. Either side.
   */
  "check-github": {
    body: Record<never, never>;
    result: { readonly me: Account | null; readonly gh: GhLogin };
  };
  /**
   * My inbox (ADR 0009): run the `when: "open"` analyzers of a PR, as the
   * panel opens on it. Answers at once with the PR's insights as they are
   * now (a result cached for its patch-id is `ready` already, the rest
   * `running`); each later state arrives as an `insights` push. Without an
   * inbox (or before it loaded) the list is what the PR has. Errors:
   * `not-found`.
   */
  "open-insights": {
    body: PrRef;
    result: { readonly insights: ReadonlyArray<InsightState> };
  };
}

/** A request about one repo. */
export interface RepoBody {
  readonly repo: RepoKey;
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
  /** The background service could not be set up, removed or restarted. */
  | "service"
  | "internal";

export interface RequestError {
  readonly code: ErrorCode;
  /** One sentence for the user. */
  readonly message: string;
  /** `stale`: the entries whose head moved since the user looked. */
  readonly details?: {
    readonly stale?: ReadonlyArray<
      PrRef & {
        readonly signed: string;
        readonly current: string;
      }
    >;
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
// my own inbox (the personal layer, ADR 0009)

/** An analyzer my inbox loaded. */
export interface InboxAnalyzer {
  readonly id: string;
  readonly title: string;
  readonly when: "poll" | "open";
  /** `default`: from the kit's `defaults()`; `yours`: written by me. */
  readonly origin: Origin;
  /** Only for these repos: the `repos` key of `inbox.ts` (`owner/name` or a glob). Absent: every repo. */
  readonly repos?: string;
}

/** An attention classifier my inbox loaded. */
export interface InboxClassifier {
  readonly name: string;
  readonly origin: Origin;
  /** Only for these repos, as for {@link InboxAnalyzer}. */
  readonly repos?: string;
}

/**
 * My inbox: where it is, what it loaded, and whether it loads. With an
 * error the parts and the results of the last good load stay in effect
 * (and on screen) until the file loads again.
 */
export interface InboxStatus {
  /** `default`: there is no `inbox.ts`, the built-in defaults run. `yours`: my `inbox.ts`. */
  readonly config: "default" | "yours";
  /** The folder (`$XDG_CONFIG_HOME/nod/inbox` unless `--inbox` names another). */
  readonly path: string;
  /** `starting`: loading (also after a save); `ready`: loaded; `error`: it does not load. */
  readonly state: "starting" | "ready" | "error";
  /** Why it does not load (a syntax error, a bad export) or keeps crashing; one line. */
  readonly error: string | null;
  readonly classifiers: ReadonlyArray<InboxClassifier>;
  readonly analyzers: ReadonlyArray<InboxAnalyzer>;
}

// ---------------------------------------------------------------------------
// pushes (server → client)

export interface Welcome {
  readonly t: "welcome";
  readonly protocol: typeof PROTOCOL_VERSION;
  /** The published version `nod serve` runs as; null for a checkout. */
  readonly version: string | null;
  /** Serving the in-memory fake data set (`nod serve --fake`), not GitHub. */
  readonly fake: boolean;
  /**
   * The `gh` account (of the first repo's host; ADR 0007, 8); null when `gh`
   * is not logged in (onboarding step 1 says so).
   */
  readonly me: Account | null;
  /** What nod serve sees of `gh` and the login (added within protocol 2; absent from an older server). */
  readonly gh?: GhLogin;
  /** Every repo it reads, in its order; empty while a `managed` list has none yet. */
  readonly repos: ReadonlyArray<RepoInfo>;
  /** Whether the list can be changed from the web app (`managed`), or is the one `--dir` clone (`fixed`). */
  readonly repoList: RepoList;
  readonly signer: SignerState;
  /**
   * The app: version, channel, updates, the service, as this side sees it
   * (added within protocol 2; absent from a server without it).
   */
  readonly app?: AppState;
  /** My inbox (ADR 0009); null: this nod serve runs none. Absent: an older server. */
  readonly inbox?: InboxStatus | null;
}

export type ServerToClient =
  | Welcome
  | ({ readonly t: "snapshot" } & Snapshot)
  | { readonly t: "signer"; readonly signer: SignerState }
  /** The account or what nod serve sees of `gh` changed (signed in after all, `gh` found…): the welcome's `me` and `gh`. */
  | { readonly t: "account"; readonly me: Account | null; readonly gh: GhLogin }
  /** The app's state changed (an update found, an install's progress, the service). */
  | { readonly t: "app"; readonly app: AppState }
  /** Every repo again, on a change of one's setup, my enrolment in one, or the list. */
  | { readonly t: "repos"; readonly repos: ReadonlyArray<RepoInfo> }
  /** My inbox's status changed: loaded, reloading after a save, or it does not load. */
  | { readonly t: "inbox"; readonly inbox: InboxStatus }
  /**
   * One PR's insights changed (an analyzer started or finished): they
   * replace that PR's `insights` until the next snapshot, which carries them too.
   */
  | {
      readonly t: "insights";
      readonly repo: RepoKey;
      readonly pr: number;
      readonly insights: ReadonlyArray<InsightState>;
    }
  | Reply
  /** Not caused by a request: a failed poll, a failed auto-merge watch, … */
  | { readonly t: "error"; readonly code: ErrorCode; readonly message: string };

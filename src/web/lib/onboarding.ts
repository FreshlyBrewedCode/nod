/**
 * Onboarding as offers (ADR 0006, the opt-in ladder), the pure part: where a
 * first open lands, the state of each step of the ladder, which offer the
 * list shows and which ones the avatar menu lists, the remembered
 * dismissals; derived from the server's state alone (the `gh` account, the
 * repo's setup, the signer). Also the passphrase rule and the words for
 * every error the setup page can meet.
 *
 * Nothing gates: once `gh` is logged in and a repo is picked, the dashboard
 * shows. The ladder's steps, 0 inbox, 1 shared policy, 2 signing (per
 * person) and 3 enforced, are offered, one at a time, and done on the setup
 * page (`#/setup/<step>`). Everything here takes one repo's setup and my
 * signer, so many repos (epic C) can ask it once per repo.
 */

import { shortName } from "../../shared/attention";
import {
  MIN_PASSPHRASE_LENGTH,
  type Account,
  type Enrolment,
  type Person,
  type PrLink,
  type SetupCheck,
  type SetupStatus,
  type SignerState,
  ladderStepOf,
} from "../../shared/protocol";
import type { Failure } from "./batch";
import { SETUP_STEPS, type SetupStep } from "./route";

/** The longest passphrase the signer takes (ADR 0004, the server's own limit). */
export const MAX_PASSPHRASE_LENGTH = 1024;

export type KeyState = "none" | "not-enrolled" | "pending" | "active";

export interface ServerState {
  readonly me: Account | null;
  readonly setup: SetupStatus;
  readonly signer: SignerState;
}

export function keyStateOf(signer: SignerState): KeyState {
  if (signer.state === "no-key") return "none";
  return signer.key.enrolment.state === "not-enrolled"
    ? "not-enrolled"
    : signer.key.enrolment.state;
}

export interface Progress {
  /** `gh` is logged in. */
  readonly signedIn: boolean;
  /** A repo is picked (always, with the GitHub source). */
  readonly repoPicked: boolean;
  readonly setup: SetupStatus["state"];
  readonly key: KeyState;
  readonly enrolment: Enrolment | null;
  /**
   * How my key gets into `.nod/allowed_signers`: as part of the setup PR
   * (I set the repo up) or its own one-line enrolment PR (I join a set-up
   * repo).
   */
  readonly enrolVia: "setup-pr" | "enrol-pr";
}

export function progressOf({ me, setup, signer }: ServerState): Progress {
  return {
    signedIn: me !== null,
    repoPicked: setup.state !== "none",
    setup: setup.state,
    key: keyStateOf(signer),
    enrolment: signer.state === "no-key" ? null : signer.key.enrolment,
    enrolVia: setup.state === "ready" ? "enrol-pr" : "setup-pr",
  };
}

// ---------------------------------------------------------------------------
// where a first open lands

/**
 * What the app shows before anything else: a calm page while `gh` is not
 * logged in, the repo picker while no repo is picked (only the fake, as the
 * GitHub source always has its clone's), and the dashboard otherwise, with
 * nothing in the repo and no key.
 */
export type Landing = "sign-in" | "pick-repo" | "dashboard";

export function landingOf({ me, setup }: Pick<ServerState, "me" | "setup">): Landing {
  if (me === null) return "sign-in";
  if (setup.state === "none") return "pick-repo";
  return "dashboard";
}

// ---------------------------------------------------------------------------
// the ladder

/** The ladder's steps (ADR 0006), as the setup page lists them; signing is the person's own. */
export const RUNGS = SETUP_STEPS;
export type Rung = SetupStep;

export const RUNG_NAMES: Readonly<Record<Rung, string>> = {
  inbox: "Inbox",
  "shared-policy": "Shared policy",
  signing: "Signing",
  enforced: "Enforced",
};

/** Who opts in to a step. */
export const RUNG_WHO: Readonly<Record<Rung, "you" | "the repository">> = {
  inbox: "you",
  "shared-policy": "the repository",
  signing: "you",
  enforced: "the repository",
};

/**
 * Where a step stands for this repo and me:
 * - `done`;
 * - `waiting`: its pull request is open (the setup PR, the PR that enrols my key);
 * - `open`: mine to take now;
 * - `later`: it needs an earlier step first (signing and enforcing need the shared policy);
 * - `not-yours`: it needs a permission I do not have (write access for the
 *   setup PR, admin rights for enforcing); someone else can take it.
 */
export type RungState = "done" | "waiting" | "open" | "later" | "not-yours";

export function rungsOf({ me, setup, signer }: ServerState): Readonly<Record<Rung, RungState>> {
  const step = ladderStepOf(setup);
  const key = keyStateOf(signer);
  const permission = setup.permission ?? null;
  const setUp = setup.state === "ready";
  return {
    inbox: me !== null && setup.state !== "none" ? "done" : "open",
    "shared-policy": setUp
      ? "done"
      : setup.state === "pending"
        ? "waiting"
        : permission === "read"
          ? "not-yours"
          : "open",
    signing:
      key === "active"
        ? "done"
        : key === "pending"
          ? "waiting"
          : setUp
            ? "open"
            : // Not set up: the first key rides in the setup PR, which only the one opening it adds.
              setup.state === "missing" && permission !== "read"
              ? "open"
              : "later",
    enforced:
      step === "enforced"
        ? "done"
        : !setUp
          ? "later"
          : permission === "admin" || permission === null
            ? "open"
            : "not-yours",
  };
}

/**
 * A step offered to me: `offer` while it is mine to take, `waiting` while its
 * pull request is open (`pr`). The inbox is never offered: it is where
 * everyone starts.
 */
export interface Offer {
  readonly rung: Exclude<Rung, "inbox">;
  readonly phase: "offer" | "waiting";
  readonly pr: PrLink | null;
}

/**
 * Every step offered to me, in the ladder's order: the avatar menu lists
 * them. Enforcing only for an admin of a repo with the shared policy, as
 * GitHub said so (unknown: the setup page still shows it, nothing offers it).
 * Signing before the shared policy only as part of the setup PR: the setup
 * offer covers it.
 */
export function offersOf(state: ServerState): ReadonlyArray<Offer> {
  if (landingOf(state) !== "dashboard") return [];
  const rungs = rungsOf(state);
  const { setup, signer } = state;
  const out: Offer[] = [];
  if (rungs["shared-policy"] === "open")
    out.push({ rung: "shared-policy", phase: "offer", pr: null });
  if (rungs["shared-policy"] === "waiting")
    out.push({ rung: "shared-policy", phase: "waiting", pr: setup.setupPr });
  if (setup.state === "ready") {
    if (rungs.signing === "open") out.push({ rung: "signing", phase: "offer", pr: null });
    if (rungs.signing === "waiting" && signer.state !== "no-key") {
      const e = signer.key.enrolment;
      out.push({ rung: "signing", phase: "waiting", pr: e.state === "pending" ? e.pr : null });
    }
  }
  if (rungs.enforced === "open" && setup.permission === "admin")
    out.push({ rung: "enforced", phase: "offer", pr: null });
  return out;
}

/**
 * The card above the list: the next step of the ladder for this repo and me,
 * one at a time. A dismissed card stays away and does not make room for the
 * next one: the ladder waits; the avatar menu and the setup page still have
 * every step. A step that moves on (the offer taken, its PR open) is a new
 * card.
 */
export function cardOf(
  state: ServerState,
  dismissed: ReadonlyArray<string>,
  host: string,
): Offer | null {
  const next = offersOf(state)[0];
  if (!next || !state.setup.repo) return null;
  return dismissed.includes(offerKey(host, state.setup.repo, next)) ? null : next;
}

/** What a dismissal remembers: the host, the repo, the step and its phase. */
export function offerKey(host: string, repo: string, offer: Offer): string {
  return `${host.toLowerCase()}/${repo.toLowerCase()}:${offer.rung}:${offer.phase}`;
}

/** How many dismissals are remembered; the oldest are dropped beyond it. */
export const DISMISSED_LIMIT = 100;

/** The remembered dismissals, from storage; anything else reads as none. */
export function readDismissed(value: unknown): ReadonlyArray<string> {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

export function dismiss(dismissed: ReadonlyArray<string>, key: string): ReadonlyArray<string> {
  return [...dismissed.filter((k) => k !== key), key].slice(-DISMISSED_LIMIT);
}

/**
 * The step the setup page opens on: the one asked for (`#/setup/<step>`),
 * else the next offer's, else the first step that is not done (someone
 * else's to take, too: it says whom to ask), else signing
 * (the key and the test signature: what is worth a second look on a ladder
 * that is all done).
 */
export function setupRungOf(state: ServerState, asked: Rung | null): Rung {
  if (asked) return asked;
  const next = offersOf(state)[0];
  if (next) return next.rung;
  const rungs = rungsOf(state);
  return RUNGS.find((r) => rungs[r] !== "done" && rungs[r] !== "later") ?? "signing";
}

/** An offer's words: the card's title, the avatar menu's line under it, the card's button. */
export interface OfferWords {
  readonly title: string;
  readonly line: string;
  /** null: the card's button is the PR's link, "Open #494". */
  readonly action: string | null;
}

export function offerWords(offer: Offer, key: KeyState): OfferWords {
  const pr = offer.pr ? `#${offer.pr.number}` : null;
  switch (offer.rung) {
    case "shared-policy":
      return offer.phase === "offer"
        ? {
            title: "Share one policy with the team",
            line: "one setup PR; its check never blocks",
            action: "Set it up",
          }
        : {
            title: pr ? `Setup PR ${pr} is open` : "The setup PR is open",
            line: "the shared policy, once it merges",
            action: null,
          };
    case "signing":
      return offer.phase === "offer"
        ? {
            title: "Sign your own agent PRs",
            line: key === "none" ? "a signing key, enrolled here" : "enrol the key you have",
            action: key === "none" ? "Create your key" : "Enrol your key",
          }
        : {
            title: "Your key is pending",
            line: pr ? `signing, once ${pr} merges` : "signing, once it is enrolled",
            action: null,
          };
    case "enforced":
      return {
        title: "Let agents merge on their own",
        line: "require the nod check",
        action: "What it changes",
      };
  }
}

// ---------------------------------------------------------------------------
// the passphrase

const length = (s: string) => [...s.normalize("NFC")].length;

/**
 * What is wrong with a new passphrase and its repetition, or null. The
 * same rule as the signer's (at least MIN_PASSPHRASE_LENGTH characters),
 * checked before anything is sent.
 */
export function passphraseProblem(
  first: string,
  second: string,
): { readonly field: "first" | "second"; readonly message: string } | null {
  const n = length(first);
  if (n === 0) return { field: "first", message: "Enter a passphrase." };
  if (n < MIN_PASSPHRASE_LENGTH)
    return {
      field: "first",
      message: `Too short: use at least ${MIN_PASSPHRASE_LENGTH} characters.`,
    };
  if (n > MAX_PASSPHRASE_LENGTH)
    return {
      field: "first",
      message: `Use at most ${MAX_PASSPHRASE_LENGTH} characters.`,
    };
  if (second === "") return { field: "second", message: "Type the passphrase again to repeat it." };
  if (first.normalize("NFC") !== second.normalize("NFC"))
    return { field: "second", message: "The two passphrases differ." };
  return null;
}

// ---------------------------------------------------------------------------
// words

/** `~/.config/nod/…` instead of a home folder's full path. */
export function shortPath(path: string): string {
  return path.replace(/^\/(?:home|Users)\/[^/]+(?=\/|$)/, "~");
}

/** The line `.nod/allowed_signers` gets for my key: `<login> namespaces="nod" ssh-ed25519 AAAA…`. */
export function signerLine(login: string, publicKey: string): string {
  const [type = "", blob = ""] = publicKey.trim().split(/\s+/);
  return `${login} namespaces="nod" ${type} ${blob}`;
}

/** `SHA256:Qx7fT0m…k2Vd9`: a fingerprint short enough for a line. */
export function shortFingerprint(fingerprint: string): string {
  const [algo, hash = ""] = fingerprint.split(":");
  if (hash.length <= 14) return fingerprint;
  return `${algo}:${hash.slice(0, 7)}…${hash.slice(-5)}`;
}

/** The teammates who could nod my enrolment: "Jonas or Ines", else "a teammate". */
export function teammates(
  people: ReadonlyArray<Person>,
  me: string,
  join: "or" | "and",
): string | null {
  const others = people.filter((p) => p.login.toLowerCase() !== me.toLowerCase());
  if (others.length === 0 || others.length > 2) return null;
  return others.map((p) => shortName(p.login, people)).join(` ${join} `);
}

/** What each check is for, in r3's words; the server's `detail` names the file. */
export const CHECK_PURPOSE: Readonly<Record<SetupCheck["id"], string>> = {
  policy: "which changes need whom. Starts with a default you can edit.",
  verifier: "the verifier, readable top to bottom; it runs from the default branch only.",
  workflow: "classifies each PR and checks signatures. Never runs PR code.",
  "allowed-signers": "the public keys that may sign. Yours goes in first.",
  "required-check": "becomes required; required approvals go from 1 to 0. Needs a repo admin.",
  "auto-merge": "so agents can merge on their own once nod is green.",
};

const OFFLINE = "nod serve did not answer. Is it still running in your terminal?";

/**
 * One calm sentence (or two) for a failed onboarding request: what happened
 * and what to do. The server's own message where it is already specific.
 */
export function onboardingError(failure: Failure): string {
  switch (failure.code) {
    case "offline":
    case "timeout":
      return OFFLINE;
    case "key-exists":
      return "There is a signing key on this machine already, and nod never replaces one from the browser. Reload this page to use it, or run `nod key create --replace` in a terminal to start over.";
    case "bad-key-file":
      return "nod cannot read your key file: it is damaged, from a newer nod, or changed while nod serve ran. Run `nod key show` in a terminal to see what is wrong, then restart nod serve.";
    case "bad-passphrase":
      return "That passphrase does not unlock the key. Try again.";
    case "locked":
      return "Unlock the key first.";
    case "no-key":
      return "Create your signing key first: the setup PR enrols it as the first signer.";
    case "already-set-up":
      return "This repository is set up already. The checks above are read again.";
    case "already-enrolled":
      return "Your key is enrolled already.";
    case "no-repo":
      return "nod serve has no repository yet. Pick one first.";
    case "github":
      if (/not logged in/i.test(failure.message)) {
        // The server names the host off github.com: `gh auth login --hostname acme.ghe.com`.
        const host = /--hostname ([\w.:-]+)/.exec(failure.message)?.[1];
        return host
          ? `nod serve is not signed in to ${host}. Run \`gh auth login --hostname ${host}\` in a terminal, then restart nod serve.`
          : "nod serve is not signed in to GitHub. Run `gh auth login` in a terminal, then restart nod serve.";
      }
      if (
        /upgrade to github pro|make this repository public|pro, team or enterprise/i.test(
          failure.message,
        )
      )
        return "GitHub refused: rulesets on private repositories need GitHub Pro, Team or Enterprise. Nothing was changed.";
      return failure.message;
    case "internal":
      return "Something went wrong in nod serve; its terminal has the details.";
    default:
      return failure.message;
  }
}

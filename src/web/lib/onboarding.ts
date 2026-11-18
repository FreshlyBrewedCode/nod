/**
 * Onboarding (r3 `12`–`16`), the pure part: where a visit starts and what is
 * done, derived from the server's state alone (the `gh` account, the repo's
 * setup, the signer), so it resumes wherever it was left; the passphrase
 * rule; the words for every error the steps can meet.
 *
 * The four steps: 1 GitHub and repository, 2 repository setup, 3 your
 * signing key (enrolment through the repo, ADR 0002), 4 test signature.
 */

import { shortName } from "../../shared/attention";
import {
  MIN_PASSPHRASE_LENGTH,
  type Account,
  type Enrolment,
  type Person,
  type SetupCheck,
  type SetupStatus,
  type SignerState,
} from "../../shared/protocol";
import type { Failure } from "./batch";

export type StepNumber = 1 | 2 | 3 | 4;

export const STEP_NAMES = [
  "GitHub and repository",
  "Repository setup",
  "Your signing key",
  "Test signature",
  "Done",
] as const;

/** The longest passphrase the signer takes (ADR 0004, the server's own limit). */
export const MAX_PASSPHRASE_LENGTH = 1024;

export type KeyState = "none" | "not-enrolled" | "pending" | "active";

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
  /** What the server says is done. Step 4 never is: a test signature is not kept. */
  readonly done: Readonly<Record<StepNumber, boolean>>;
  /** Where a visit starts. */
  readonly start: StepNumber;
  /** Onboarding shows instead of the dashboard: the setup or the key is not ready. */
  readonly needed: boolean;
}

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

export function progressOf({ me, setup, signer }: ServerState): Progress {
  const signedIn = me !== null;
  const repoPicked = setup.state !== "none";
  const key = keyStateOf(signer);
  const done: Record<StepNumber, boolean> = {
    1: signedIn && repoPicked,
    2: setup.state === "ready" || setup.state === "pending",
    3: key === "pending" || key === "active",
    4: false,
  };
  // Nothing done yet (no key, and no setup PR of mine): from the beginning,
  // for the one setting a repo up and for a teammate joining one alike.
  const start: StepNumber = !done[1]
    ? 1
    : key === "none"
      ? setup.state === "pending"
        ? 3
        : 1
      : !done[2]
        ? 2
        : !done[3]
          ? 3
          : 4;
  return {
    signedIn,
    repoPicked,
    setup: setup.state,
    key,
    enrolment: signer.state === "no-key" ? null : signer.key.enrolment,
    enrolVia: setup.state === "ready" ? "enrol-pr" : "setup-pr",
    done,
    start,
    needed:
      !signedIn ||
      !repoPicked ||
      setup.state === "missing" ||
      key === "none" ||
      key === "not-enrolled",
  };
}

/** Where "Continue" leads from a step: the next one not done (a set-up repo skips step 2). */
export function nextStep(progress: Progress, from: StepNumber): StepNumber {
  for (let s = from + 1; s <= 4; s++) if (!progress.done[s as StepNumber]) return s as StepNumber;
  return 4;
}

/** Steps the stepper lets one go back or ahead to: the ones done, and the first open one. */
export function reachable(progress: Progress, step: StepNumber): boolean {
  if (progress.done[step]) return true;
  for (let s = 1; s < step; s++) if (!progress.done[s as StepNumber]) return false;
  return true;
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
      return "nod serve has no repository yet. Pick one in step 1.";
    case "github":
      if (/not logged in/i.test(failure.message))
        return "nod serve is not signed in to GitHub. Run `gh auth login` in a terminal, then restart nod serve.";
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

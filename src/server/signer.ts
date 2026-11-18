/**
 * The signing key, behind one seam. `nod serve` holds the decrypted key in
 * memory while unlocked and locks on its own after N minutes (15 by default).
 *
 * - `FakeSigner` (for `nod serve --fake`): any non-empty passphrase unlocks
 *   except the literal `wrong`, which fails so the UI's error state can be
 *   seen; signatures are placeholders in the SSHSIG armor.
 * - The real signer (an ed25519 key under `~/.config/nod`, encrypted with
 *   scrypt + AES-GCM, producing SSHSIG that `ssh-keygen -Y verify` accepts)
 *   is a later task: `keyFileSigner` is its stub.
 *
 * Passphrases are never logged, and never part of an error message.
 */

import { createHash } from "node:crypto";

import { DEFAULT_UNLOCK_MINUTES, MAX_UNLOCK_MINUTES } from "../shared/protocol";
import type { Clock, Timer } from "./clock";

/** The key without its enrolment, which the repo decides (`Source.enrolment`). */
export interface SignerKey {
  readonly fingerprint: string;
  readonly publicKey: string;
  readonly location: string;
}

export type SignerStatus =
  | { readonly state: "no-key" }
  | { readonly state: "locked"; readonly key: SignerKey }
  | {
      readonly state: "unlocked";
      readonly key: SignerKey;
      readonly until: number;
      readonly once: boolean;
    };

export interface UnlockOptions {
  /** Clamped to [1, MAX_UNLOCK_MINUTES]; default DEFAULT_UNLOCK_MINUTES. */
  readonly minutes?: number;
  /** Lock again right after the next `sign`. */
  readonly once?: boolean;
}

export interface Signer {
  status(): SignerStatus;
  /** Throws `SignerError` `no-key` or `bad-passphrase`. */
  unlock(passphrase: string, options?: UnlockOptions): Promise<void>;
  lock(): void;
  /**
   * SSHSIG over exactly the bytes of `payloadLine`, namespace `nod`, armored.
   * Throws `SignerError` `locked` or `no-key`.
   */
  sign(payloadLine: string): Promise<string>;
  /** Verify against the key's own public half (onboarding's test signature). */
  verify(payloadLine: string, signature: string): Promise<boolean>;
  /**
   * Create a new key encrypted with `passphrase`, or adopt the private key at
   * `path`. Throws `SignerError` `key-exists`, `weak-passphrase`, `not-found`.
   */
  createKey(passphrase: string, path?: string): Promise<SignerKey>;
  /** Called on every change of `status()`, auto-lock included. */
  subscribe(listener: () => void): () => void;
  stop(): void;
}

export type SignerErrorCode =
  | "no-key"
  | "locked"
  | "bad-passphrase"
  | "weak-passphrase"
  | "key-exists"
  | "not-found"
  | "not-implemented";

export class SignerError extends Error {
  constructor(
    readonly code: SignerErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export function unlockMinutes(minutes: number | undefined): number {
  if (minutes === undefined || !Number.isFinite(minutes)) return DEFAULT_UNLOCK_MINUTES;
  return Math.min(MAX_UNLOCK_MINUTES, Math.max(1, Math.round(minutes)));
}

/**
 * The unlock window both signers share: one timer, one listener list. The
 * subclass says how a passphrase opens the key and how a line is signed.
 */
export abstract class UnlockWindow implements Signer {
  private key: SignerKey | null;
  private unlocked: { until: number; once: boolean; timer: Timer } | null = null;
  private listeners = new Set<() => void>();

  constructor(
    protected readonly clock: Clock,
    key: SignerKey | null,
  ) {
    this.key = key;
  }

  status(): SignerStatus {
    if (!this.key) return { state: "no-key" };
    // The timer may be late (a suspended laptop): the time is what counts.
    if (this.unlocked && this.clock.now() >= this.unlocked.until) this.lockNow();
    if (!this.unlocked) return { state: "locked", key: this.key };
    return {
      state: "unlocked",
      key: this.key,
      until: this.unlocked.until,
      once: this.unlocked.once,
    };
  }

  async unlock(passphrase: string, options: UnlockOptions = {}): Promise<void> {
    if (!this.key) throw new SignerError("no-key", "There is no signing key yet.");
    await this.open(passphrase);
    this.unlocked?.timer.clear();
    const ms = unlockMinutes(options.minutes) * 60_000;
    this.unlocked = {
      until: this.clock.now() + ms,
      once: options.once ?? false,
      timer: this.clock.after(ms, () => this.lockNow()),
    };
    this.emit();
  }

  lock(): void {
    this.lockNow();
  }

  async sign(payloadLine: string): Promise<string> {
    const status = this.status();
    if (status.state === "no-key") throw new SignerError("no-key", "There is no signing key yet.");
    if (status.state === "locked") throw new SignerError("locked", "Signing is locked.");
    const signature = await this.signLine(payloadLine);
    if (status.once) this.lockNow();
    return signature;
  }

  abstract verify(payloadLine: string, signature: string): Promise<boolean>;

  async createKey(passphrase: string, path?: string): Promise<SignerKey> {
    if (this.key) throw new SignerError("key-exists", "There is a signing key already.");
    this.key = await this.makeKey(passphrase, path);
    this.emit();
    return this.key;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  stop(): void {
    this.unlocked?.timer.clear();
    this.unlocked = null;
    this.listeners.clear();
  }

  /** Throws `bad-passphrase`; keeps the decrypted key on success. */
  protected abstract open(passphrase: string): Promise<void>;
  protected abstract signLine(payloadLine: string): Promise<string>;
  protected abstract makeKey(passphrase: string, path?: string): Promise<SignerKey>;
  /** Forget the decrypted key. */
  protected abstract close(): void;

  private lockNow() {
    if (!this.unlocked) return;
    this.unlocked.timer.clear();
    this.unlocked = null;
    this.close();
    this.emit();
  }

  private emit() {
    for (const listener of this.listeners) listener();
  }
}

// ---------------------------------------------------------------------------
// the fake signer

export const FAKE_KEY: SignerKey = {
  fingerprint: "SHA256:Qx7fT0mFakeFakeFakeFakeFakeFakeFakek2Vd9",
  publicKey:
    "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFakeFakeFakeFakeFakeFakeFakeFakeFakeFake nod-fake",
  location: "in memory (nod serve --fake)",
};

/** The passphrase the fake signer refuses, to show the UI's error state. */
export const FAKE_WRONG_PASSPHRASE = "wrong";

const armor = (body: string) =>
  `-----BEGIN SSH SIGNATURE-----\n${body.match(/.{1,70}/g)!.join("\n")}\n-----END SSH SIGNATURE-----`;

/** A signature-shaped placeholder: base64 of `FAKESSHSIG` and the payload's hash. */
export function fakeSignature(payloadLine: string): string {
  const digest = createHash("sha256").update(payloadLine).digest();
  return armor(Buffer.concat([Buffer.from("FAKESSHSIG"), digest]).toString("base64"));
}

export class FakeSigner extends UnlockWindow {
  constructor(clock: Clock, options: { hasKey?: boolean } = {}) {
    super(clock, options.hasKey === false ? null : FAKE_KEY);
  }

  protected async open(passphrase: string): Promise<void> {
    if (passphrase === "" || passphrase === FAKE_WRONG_PASSPHRASE)
      throw new SignerError("bad-passphrase", "That passphrase does not unlock the key.");
  }

  protected async signLine(payloadLine: string): Promise<string> {
    return fakeSignature(payloadLine);
  }

  async verify(payloadLine: string, signature: string): Promise<boolean> {
    return signature === fakeSignature(payloadLine);
  }

  protected async makeKey(passphrase: string): Promise<SignerKey> {
    if (passphrase.length < 8)
      throw new SignerError("weak-passphrase", "Use a passphrase of at least 8 characters.");
    return FAKE_KEY;
  }

  protected close(): void {}
}

// ---------------------------------------------------------------------------
// the real signer: a later task

/** The key-file signer (ed25519 under `~/.config/nod`). Not built yet. */
export function keyFileSigner(_clock: Clock): Signer {
  throw new SignerError(
    "not-implemented",
    "The key-file signer is not implemented yet. Run `nod serve --fake` to try the dashboard.",
  );
}

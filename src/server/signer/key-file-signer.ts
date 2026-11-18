/**
 * The real signer: the passphrase-encrypted key file (`key-store.ts`), opened
 * into memory for the unlock window (`UnlockWindow` in `../signer.ts`), and
 * SSHSIG output (`sshsig.ts`). ADR 0004.
 *
 * While unlocked the key lives in this process as a `KeyObject`; locking
 * drops it. JS cannot promise that the bytes are gone from memory at that
 * moment (the garbage collector frees them later, and the passphrase is an
 * immutable string), so every zeroing here is best effort.
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { verifyNod } from "../../kit/sshsig.ts";
import type { Clock } from "../clock";
import { MAX_PASSPHRASE_LENGTH, SignerError, UnlockWindow, type SignerKey } from "../signer";
import { ed25519Method } from "./ed25519";
import { createKeyFile, decryptSeed, keyOf, readKeyFile, type ScryptParams } from "./key-store";
import { allowedSignersLine, samePublicKey } from "./ssh-wire";
import { signSshsig, type SigningMethod } from "./sshsig";

export interface KeyFileSignerOptions {
  readonly clock: Clock;
  /** The key file, normally `defaultKeyFile()`. */
  readonly file: string;
  /** For new keys; tests pass cheap ones. Default DEFAULT_SCRYPT. */
  readonly scrypt?: ScryptParams;
  /** How long a wrong passphrase waits before it fails (default 1 s). */
  readonly wrongPassphraseDelayMs?: number;
  /** `ssh-keygen` for the self-check (default from `PATH`). */
  readonly sshKeygen?: string;
}

/** The principal the self-check's throwaway `allowed_signers` names. */
const SELF = "nod-self-check";

export class KeyFileSigner extends UnlockWindow {
  private readonly options: KeyFileSignerOptions;
  private method: SigningMethod | null = null;
  /** Unlocks run one at a time: each costs scrypt's memory. */
  private queue: Promise<unknown> = Promise.resolve();

  /** Throws `bad-key-file` when the key file is damaged. */
  constructor(options: KeyFileSignerOptions) {
    const record = readKeyFile(options.file);
    super(options.clock, record ? keyOf(record, options.file) : null);
    this.options = options;
  }

  /**
   * Verifies with OpenSSH, as a repo's verifier will: `ssh-keygen -Y verify`
   * against a throwaway `allowed_signers` that holds only this key.
   */
  async verify(payloadLine: string, signature: string): Promise<boolean> {
    const status = this.status();
    if (status.state === "no-key") return false;
    const dir = await mkdtemp(join(tmpdir(), "nod-self-check-"));
    try {
      const allowedSignersPath = join(dir, "allowed_signers");
      await writeFile(allowedSignersPath, `${allowedSignersLine(SELF, status.key.publicKey)}\n`, {
        mode: 0o600,
      });
      const check = await verifyNod({
        payloadLine,
        signature,
        reviewer: SELF,
        allowedSignersPath,
        ...(this.options.sshKeygen && { sshKeygen: this.options.sshKeygen }),
      });
      return check.ok;
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  protected open(passphrase: string): Promise<void> {
    const opened = this.queue.then(() => this.openNow(passphrase));
    this.queue = opened.catch(() => {});
    return opened;
  }

  private async openNow(passphrase: string): Promise<void> {
    const shown = this.status();
    if (shown.state === "no-key") throw new SignerError("no-key", "There is no signing key yet.");
    // Read again: what signs must be the key the app shows (and enrolled).
    const record = readKeyFile(this.options.file);
    if (!record || !samePublicKey(record.publicKey, shown.key.publicKey))
      throw new SignerError(
        "bad-key-file",
        "The key file changed since nod serve started. Restart nod serve.",
      );
    let seed: Buffer;
    try {
      // No key was made with a longer one (`length` counts UTF-16 units,
      // at most twice the characters); do not spend scrypt on it.
      if (passphrase.length > MAX_PASSPHRASE_LENGTH * 2)
        throw new SignerError("bad-passphrase", "That passphrase does not unlock the key.");
      seed = await decryptSeed(record, passphrase);
    } catch (error) {
      if (error instanceof SignerError && error.code === "bad-passphrase") {
        // Slows guessing through the socket a little; offline guessing is scrypt's job.
        const ms = this.options.wrongPassphraseDelayMs ?? 1000;
        if (ms > 0) await new Promise((resolve) => setTimeout(resolve, ms));
      }
      throw error;
    }
    try {
      const method = ed25519Method(seed);
      this.method?.dispose();
      this.method = method;
    } finally {
      seed.fill(0);
    }
  }

  protected async signLine(payloadLine: string): Promise<string> {
    if (!this.method) throw new SignerError("locked", "Signing is locked.");
    return signSshsig(payloadLine, this.method);
  }

  protected async makeKey(passphrase: string, path?: string): Promise<SignerKey> {
    if (path !== undefined)
      throw new SignerError(
        "not-implemented",
        "Adopting an existing private key is not supported; create a new key for nod.",
      );
    const { record } = await createKeyFile(this.options.file, passphrase, {
      ...(this.options.scrypt && { scrypt: this.options.scrypt }),
      now: this.clock.now(),
    });
    return keyOf(record, this.options.file);
  }

  protected close(): void {
    this.method?.dispose();
    this.method = null;
  }
}

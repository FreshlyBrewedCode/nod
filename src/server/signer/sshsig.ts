/**
 * SSHSIG output, per OpenSSH's `PROTOCOL.sshsig`, so plain
 * `ssh-keygen -Y verify` checks a nod. The kit verifies with OpenSSH; this is
 * the one place nod builds a signature itself, so it follows the spec to the
 * byte (the tests compare it with `ssh-keygen -Y sign`'s output).
 *
 * The envelope is the same whatever makes the signature: a `SigningMethod`
 * only signs the inner blob. Today that is the ed25519 key the passphrase
 * opens (`ed25519.ts`); an ssh-agent (Touch ID through the Secure Enclave,
 * 1Password) fits the same seam, since `SSH_AGENTC_SIGN_REQUEST` takes the
 * same key blob and data and returns the same signature blob.
 */

import { createHash } from "node:crypto";

import { NOD_NAMESPACE } from "../../kit/nod.ts";
import { sshString, uint32 } from "./ssh-wire";

const MAGIC = Buffer.from("SSHSIG", "ascii");
const VERSION = 1;
const HASH = "sha512";

/** What makes a signature. It never sees the message, only the blob to sign. */
export interface SigningMethod {
  /** The SSH public key blob (`string(type) string(key)`). */
  readonly publicKeyBlob: Buffer;
  /** The SSH signature blob over `data`: `string(algorithm) string(signature)`. */
  signData(data: Buffer): Promise<Buffer>;
  /** Forget any secret it holds. */
  dispose(): void;
}

/**
 * The blob the key signs: `"SSHSIG" string(namespace) string(reserved = "")
 * string("sha512") string(SHA-512(message))`. The preamble has no length.
 */
export function signedData(message: Uint8Array, namespace: string): Buffer {
  return Buffer.concat([
    MAGIC,
    sshString(namespace),
    sshString(""),
    sshString(HASH),
    sshString(createHash("sha512").update(message).digest()),
  ]);
}

/**
 * The armored signature over exactly `message`'s UTF-8 bytes (no newline
 * added), namespace `nod` unless told otherwise. The outer blob is
 * `"SSHSIG" uint32(1) string(public key) string(namespace) string(reserved)
 * string("sha512") string(signature)`.
 */
export async function signSshsig(
  message: string | Uint8Array,
  method: SigningMethod,
  namespace: string = NOD_NAMESPACE,
): Promise<string> {
  const bytes = typeof message === "string" ? Buffer.from(message, "utf8") : message;
  const signature = await method.signData(signedData(bytes, namespace));
  const blob = Buffer.concat([
    MAGIC,
    uint32(VERSION),
    sshString(method.publicKeyBlob),
    sshString(namespace),
    sshString(""),
    sshString(HASH),
    sshString(signature),
  ]);
  return armor(blob);
}

/** As `ssh-keygen -Y sign` writes it: base64 wrapped at 70 columns, a newline at the end. */
export function armor(blob: Uint8Array): string {
  const lines =
    Buffer.from(blob)
      .toString("base64")
      .match(/.{1,70}/g) ?? [];
  return `-----BEGIN SSH SIGNATURE-----\n${lines.join("\n")}\n-----END SSH SIGNATURE-----\n`;
}

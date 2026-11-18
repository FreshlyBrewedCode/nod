/**
 * The bits of the SSH wire format (RFC 4251 §5) the signer needs: `string`
 * and `uint32`, the ed25519 public key blob (RFC 8709), the OpenSSH public
 * key line and its `SHA256:` fingerprint.
 */

import { createHash } from "node:crypto";

export const ED25519 = "ssh-ed25519";

/** `uint32`: four bytes, big-endian. */
export function uint32(n: number): Buffer {
  const out = Buffer.alloc(4);
  out.writeUInt32BE(n);
  return out;
}

/** `string`: a uint32 length, then the bytes. */
export function sshString(data: string | Uint8Array): Buffer {
  const bytes = typeof data === "string" ? Buffer.from(data, "utf8") : Buffer.from(data);
  return Buffer.concat([uint32(bytes.length), bytes]);
}

/** Reads `string`s one after the other; throws on a short or trailing buffer. */
export class SshReader {
  private at = 0;
  constructor(private readonly buf: Uint8Array) {}

  string(): Buffer {
    if (this.at + 4 > this.buf.length) throw new Error("truncated SSH string");
    const len = Buffer.from(this.buf.subarray(this.at, this.at + 4)).readUInt32BE();
    const start = this.at + 4;
    if (start + len > this.buf.length) throw new Error("truncated SSH string");
    this.at = start + len;
    return Buffer.from(this.buf.subarray(start, this.at));
  }

  end(): void {
    if (this.at !== this.buf.length) throw new Error("trailing bytes after SSH data");
  }
}

/** The public key blob: `string("ssh-ed25519") string(32-byte key)`. */
export function ed25519PublicKeyBlob(publicKey: Uint8Array): Buffer {
  if (publicKey.length !== 32) throw new Error("an ed25519 public key has 32 bytes");
  return Buffer.concat([sshString(ED25519), sshString(publicKey)]);
}

/** `ssh-ed25519 AAAA… [comment]`, as in a `.pub` file. */
export function publicKeyLine(blob: Uint8Array, comment?: string): string {
  const line = `${ED25519} ${Buffer.from(blob).toString("base64")}`;
  return comment ? `${line} ${comment}` : line;
}

/**
 * The key blob of an OpenSSH public key line (`ssh-ed25519 AAAA… [comment]`).
 * Throws unless it is a well-formed ed25519 key whose blob names the same
 * type as the line. The comment is ignored.
 */
export function parsePublicKeyLine(line: string): Buffer {
  const [type, base64] = line.trim().split(/\s+/);
  if (type !== ED25519 || !base64 || !/^[A-Za-z0-9+/]+={0,2}$/.test(base64))
    throw new Error("not an ssh-ed25519 public key line");
  const blob = Buffer.from(base64, "base64");
  const reader = new SshReader(blob);
  const inner = reader.string().toString("utf8");
  const key = reader.string();
  reader.end();
  if (inner !== ED25519 || key.length !== 32) throw new Error("not an ssh-ed25519 public key");
  return blob;
}

/**
 * Whether two public key lines name the same key: their blobs are equal,
 * whatever the comments say. Anything unparsable is never the same.
 */
export function samePublicKey(a: string, b: string): boolean {
  try {
    return parsePublicKeyLine(a).equals(parsePublicKeyLine(b));
  } catch {
    return false;
  }
}

/**
 * What identifies a key in a public key line: `type base64` without the
 * comment, the base64 re-encoded from the decoded blob, so two spellings of
 * one key compare equal. A line that is not an ed25519 key (the fake
 * signer's placeholder) falls back to its first two fields.
 */
export function publicKeyId(line: string): string {
  try {
    return publicKeyLine(parsePublicKeyLine(line));
  } catch {
    return line.trim().split(/\s+/).slice(0, 2).join(" ");
  }
}

/** `SHA256:…`, as `ssh-keygen -l` prints it (unpadded base64 of the blob's SHA-256). */
export function fingerprint(blob: Uint8Array): string {
  return `SHA256:${createHash("sha256").update(blob).digest("base64").replace(/=+$/, "")}`;
}

/** The `.nod/allowed_signers` line for `login`: `<login> ssh-ed25519 AAAA…`, no comment. */
export function allowedSignersLine(login: string, publicKey: string): string {
  return `${login} ${publicKeyLine(parsePublicKeyLine(publicKey))}`;
}

/**
 * The signing key on disk (ADR 0004): one small JSON file under the config
 * dir, `signing-key.json` (mode 0600, directory 0700). It holds the public
 * key in clear, so the app can show it and build the `allowed_signers` line
 * without a passphrase, and the 32-byte ed25519 seed encrypted with
 * AES-256-GCM under a key that scrypt derives from the passphrase.
 *
 * ```json
 * { "nod": "signing-key", "version": 1,
 *   "publicKey": "ssh-ed25519 AAAA… nod", "created": "2026-11-18T14:20:00.000Z",
 *   "kdf": { "name": "scrypt", "N": 131072, "r": 8, "p": 1, "salt": "<16 bytes, base64>" },
 *   "cipher": { "name": "aes-256-gcm", "nonce": "<12 bytes>", "ciphertext": "<32 bytes>", "tag": "<16 bytes>" } }
 * ```
 *
 * The GCM additional data binds the public key to the ciphertext, and after
 * decrypting, the seed's own public key must equal it: a file whose public
 * half was swapped never signs. The plain key is never written anywhere; the
 * passphrase is never logged and never part of an error message.
 */

import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scrypt as scryptCallback,
} from "node:crypto";
import {
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

import { checkNewPassphrase, SignerError, type SignerKey } from "../signer";
import { configDir } from "../token";
import { generateEd25519, publicKeyOfSeed } from "./ed25519";
import { ed25519PublicKeyBlob, fingerprint, parsePublicKeyLine, publicKeyLine } from "./ssh-wire";

export const KEY_FILE_NAME = "signing-key.json";
const FORMAT = "signing-key";
const VERSION = 1;
/** The public key line's comment. Nothing about the machine or the person. */
export const KEY_COMMENT = "nod";

export interface ScryptParams {
  readonly N: number;
  readonly r: number;
  readonly p: number;
}

/**
 * 2^17 × 8 × 128 bytes = 128 MiB and about 0.2–0.3 s per try on a current
 * laptop CPU; 2^18 doubled both for little gain. Measured in ADR 0004.
 */
export const DEFAULT_SCRYPT: ScryptParams = { N: 2 ** 17, r: 8, p: 1 };

/** The file as stored. Binary fields are base64. */
export interface KeyRecord {
  readonly nod: typeof FORMAT;
  readonly version: typeof VERSION;
  readonly publicKey: string;
  readonly created: string;
  readonly kdf: { readonly name: "scrypt"; readonly salt: string } & ScryptParams;
  readonly cipher: {
    readonly name: "aes-256-gcm";
    readonly nonce: string;
    readonly ciphertext: string;
    readonly tag: string;
  };
}

/** `$XDG_CONFIG_HOME/nod/signing-key.json`, else `~/.config/nod/signing-key.json`. */
export function defaultKeyFile(env?: Readonly<Record<string, string | undefined>>): string {
  return join(configDir(env), KEY_FILE_NAME);
}

/** The key as the signer reports it. */
export function keyOf(record: KeyRecord, file: string): SignerKey {
  return {
    fingerprint: fingerprint(parsePublicKeyLine(record.publicKey)),
    publicKey: record.publicKey,
    location: file,
  };
}

/** The stored key, or null when there is none. Throws `bad-key-file` for a damaged one. */
export function readKeyFile(file: string): KeyRecord | null {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") return null;
    throw new SignerError("bad-key-file", `The key file ${file} cannot be read.`);
  }
  const record = parseRecord(text);
  if (!record)
    throw new SignerError("bad-key-file", `The key file ${file} is damaged or of a newer version.`);
  // It is encrypted, but nobody else needs to read it either.
  try {
    chmodSync(file, 0o600);
  } catch {}
  return record;
}

export interface CreateOptions {
  /** Cheap parameters for tests; the default is DEFAULT_SCRYPT. */
  readonly scrypt?: ScryptParams;
  /** Move an existing key file aside instead of refusing. */
  readonly replace?: boolean;
  readonly now?: number;
}

export interface Created {
  readonly record: KeyRecord;
  /** Where the replaced key file was moved; null when there was none. */
  readonly replaced: string | null;
}

/**
 * Create a new key, encrypt it with `passphrase` and write it to `file`.
 * Throws `weak-passphrase`, or `key-exists` unless `replace` is set; with
 * `replace` the old file is kept next to it as `signing-key.json.replaced-<time>`.
 */
export async function createKeyFile(
  file: string,
  passphrase: string,
  options: CreateOptions = {},
): Promise<Created> {
  checkNewPassphrase(passphrase);
  if (!options.replace && existsSync(file))
    throw new SignerError("key-exists", `There is a signing key already (${file}).`);
  const params = options.scrypt ?? DEFAULT_SCRYPT;
  checkParams(params);
  const now = options.now ?? Date.now();
  const { seed, publicKey } = generateEd25519();
  const blob = ed25519PublicKeyBlob(publicKey);
  const salt = randomBytes(16);
  const nonce = randomBytes(12);
  const aesKey = await deriveKey(passphrase, salt, params);
  let ciphertext: Buffer;
  let tag: Buffer;
  try {
    const cipher = createCipheriv("aes-256-gcm", aesKey, nonce);
    cipher.setAAD(additionalData(blob));
    ciphertext = Buffer.concat([cipher.update(seed), cipher.final()]);
    tag = cipher.getAuthTag();
  } finally {
    aesKey.fill(0);
    seed.fill(0);
  }
  const record: KeyRecord = {
    nod: FORMAT,
    version: VERSION,
    publicKey: publicKeyLine(blob, KEY_COMMENT),
    created: new Date(now).toISOString(),
    kdf: { name: "scrypt", N: params.N, r: params.r, p: params.p, salt: salt.toString("base64") },
    cipher: {
      name: "aes-256-gcm",
      nonce: nonce.toString("base64"),
      ciphertext: ciphertext.toString("base64"),
      tag: tag.toString("base64"),
    },
  };
  const replaced = writeRecord(file, record, options.replace ?? false, now);
  return { record, replaced };
}

/**
 * The 32-byte seed. Throws `bad-passphrase` when the GCM tag does not match,
 * which is a wrong passphrase or a tampered file (the two cannot be told
 * apart), and `bad-key-file` when the seed does not belong to the public key.
 * The caller zeroes the seed when done.
 */
export async function decryptSeed(record: KeyRecord, passphrase: string): Promise<Buffer> {
  const blob = parsePublicKeyLine(record.publicKey);
  const salt = Buffer.from(record.kdf.salt, "base64");
  const aesKey = await deriveKey(passphrase, salt, record.kdf);
  let seed: Buffer;
  try {
    const decipher = createDecipheriv(
      "aes-256-gcm",
      aesKey,
      Buffer.from(record.cipher.nonce, "base64"),
    );
    decipher.setAAD(additionalData(blob));
    decipher.setAuthTag(Buffer.from(record.cipher.tag, "base64"));
    seed = Buffer.concat([
      decipher.update(Buffer.from(record.cipher.ciphertext, "base64")),
      decipher.final(),
    ]);
  } catch {
    throw new SignerError("bad-passphrase", "That passphrase does not unlock the key.");
  } finally {
    aesKey.fill(0);
  }
  if (seed.length !== 32 || !ed25519PublicKeyBlob(publicKeyOfSeed(seed)).equals(blob)) {
    seed.fill(0);
    throw new SignerError("bad-key-file", "The key file's public key does not match its secret.");
  }
  return seed;
}

// ---------------------------------------------------------------------------

/** GCM's additional data: the format and the public key blob. */
function additionalData(publicKeyBlob: Buffer): Buffer {
  return Buffer.concat([Buffer.from(`nod-${FORMAT}-v${VERSION}\0`, "utf8"), publicKeyBlob]);
}

/** NFC first, so the same passphrase typed on another keyboard derives the same key. */
function deriveKey(passphrase: string, salt: Buffer, params: ScryptParams): Promise<Buffer> {
  const password = Buffer.from(passphrase.normalize("NFC"), "utf8");
  return new Promise((resolve, reject) =>
    scryptCallback(
      password,
      salt,
      32,
      { N: params.N, r: params.r, p: params.p, maxmem: 2 * 128 * params.N * params.r * params.p },
      (error, key) => {
        password.fill(0);
        if (error)
          reject(new SignerError("bad-key-file", "The key file's scrypt parameters are unusable."));
        else resolve(key);
      },
    ),
  );
}

/** Bounds for parameters read from a file: cheap enough for tests, never a memory bomb. */
function paramsProblem(p: ScryptParams): string | null {
  const isInt = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n);
  if (!isInt(p.N) || p.N < 2 ** 10 || p.N > 2 ** 20 || (p.N & (p.N - 1)) !== 0)
    return "N must be a power of two in [2^10, 2^20]";
  if (!isInt(p.r) || p.r < 1 || p.r > 16) return "r must be in [1, 16]";
  if (!isInt(p.p) || p.p < 1 || p.p > 4) return "p must be in [1, 4]";
  if (128 * p.N * p.r * p.p > 2 ** 30) return "scrypt would need more than 1 GiB";
  return null;
}

function checkParams(p: ScryptParams): void {
  const problem = paramsProblem(p);
  if (problem) throw new Error(`bad scrypt parameters: ${problem}`);
}

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;
const bytes = (v: unknown, length: number): boolean =>
  typeof v === "string" && BASE64.test(v) && Buffer.from(v, "base64").length === length;

function parseRecord(text: string): KeyRecord | null {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return null;
  }
  const r = v as Partial<KeyRecord> | null;
  if (!r || typeof r !== "object" || r.nod !== FORMAT || r.version !== VERSION) return null;
  if (typeof r.publicKey !== "string" || typeof r.created !== "string") return null;
  try {
    parsePublicKeyLine(r.publicKey);
  } catch {
    return null;
  }
  const { kdf, cipher } = r;
  if (!kdf || kdf.name !== "scrypt" || paramsProblem(kdf) || !bytes(kdf.salt, 16)) return null;
  if (
    !cipher ||
    cipher.name !== "aes-256-gcm" ||
    !bytes(cipher.nonce, 12) ||
    !bytes(cipher.ciphertext, 32) ||
    !bytes(cipher.tag, 16)
  )
    return null;
  return r as KeyRecord;
}

/**
 * Writes through a temp file in the same directory, so the key file is
 * either absent or complete. Without `replace`, `link` refuses to overwrite
 * a file that appeared meanwhile.
 */
function writeRecord(
  file: string,
  record: KeyRecord,
  replace: boolean,
  now: number,
): string | null {
  const dir = dirname(file);
  // 0700 when nod creates it (the umask could loosen the mode); an existing directory is left alone.
  if (mkdirSync(dir, { recursive: true, mode: 0o700 }) !== undefined) chmodSync(dir, 0o700);
  const tmp = `${file}.tmp-${randomBytes(6).toString("hex")}`;
  writeFileSync(tmp, `${JSON.stringify(record, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  try {
    chmodSync(tmp, 0o600);
    if (!replace) {
      try {
        linkSync(tmp, file);
      } catch (error) {
        if ((error as { code?: string }).code === "EEXIST")
          throw new SignerError("key-exists", `There is a signing key already (${file}).`);
        throw error;
      }
      return null;
    }
    let replaced: string | null = null;
    if (existsSync(file)) {
      replaced = `${file}.replaced-${new Date(now).toISOString().replace(/[:.]/g, "-")}`;
      renameSync(file, replaced);
    }
    renameSync(tmp, file);
    return replaced;
  } finally {
    try {
      unlinkSync(tmp);
    } catch {}
  }
}

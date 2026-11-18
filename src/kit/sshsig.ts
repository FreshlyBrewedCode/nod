/**
 * Signature checks, done by OpenSSH: `ssh-keygen -Y verify` against the
 * repo's `.nod/allowed_signers` (ADR 0002), namespace `nod`. The kit never
 * does crypto itself.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { run } from "./exec.ts";
import {
  claimedReviewer,
  decodePayload,
  LOGIN_RE,
  NOD_NAMESPACE,
  type NodBlock,
  type NodPayload,
} from "./nod.ts";

/** Input of {@link verifyNod}. */
export interface VerifyNodInput {
  /** The exact signed bytes (no trailing newline). */
  payloadLine: string;
  /** The armored SSHSIG. */
  signature: string;
  /** The principal to verify against, i.e. the claimed GitHub login. */
  reviewer: string;
  /** Path to the trust root, normally `.nod/allowed_signers` from the base branch. */
  allowedSignersPath: string;
  /** Program to run (default `ssh-keygen` from `PATH`). */
  sshKeygen?: string;
}

/** Result of {@link verifyNod}. `reason` is `ssh-keygen`'s message, shortened. */
export type SignatureCheck = { ok: true } | { ok: false; reason: string };

/**
 * Checks one signature: `ssh-keygen -Y verify -f <allowed_signers> -I
 * <reviewer> -n nod -s <sigfile>` with the payload on stdin. The payload and
 * signature go through temp files that are removed afterwards.
 */
export async function verifyNod(input: VerifyNodInput): Promise<SignatureCheck> {
  const { payloadLine, signature, reviewer, allowedSignersPath, sshKeygen = "ssh-keygen" } = input;
  if (!LOGIN_RE.test(reviewer)) return { ok: false, reason: "reviewer is not a valid login" };
  const dir = await mkdtemp(join(tmpdir(), "nod-verify-"));
  try {
    const sigPath = join(dir, "payload.sig");
    await writeFile(sigPath, signature.replace(/\r/g, ""), { mode: 0o600 });
    const args = [
      "-Y",
      "verify",
      "-f",
      allowedSignersPath,
      "-I",
      reviewer,
      "-n",
      NOD_NAMESPACE,
      "-s",
      sigPath,
    ];
    const r = await run(sshKeygen, args, { input: payloadLine, timeoutMs: 20_000 });
    if (r.status === 0) return { ok: true };
    const message = (r.stderr || r.stdout).trim().split("\n").pop() ?? "";
    return { ok: false, reason: message.slice(0, 200) || `ssh-keygen exited with ${r.status}` };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** A nod whose signature verified and whose payload is well-formed. */
export interface VerifiedNod {
  payload: NodPayload;
  /** The exact signed line, e.g. to dedupe copies of a batch nod. */
  payloadLine: string;
}

/** A block that did not verify, with the reviewer it claimed if one could be read. */
export interface RejectedNod {
  reviewer: string | null;
  reason: string;
}

/** Result of {@link verifyNodBlock}. */
export type BlockCheck = { ok: true; nod: VerifiedNod } | { ok: false; rejected: RejectedNod };

/**
 * The whole check for one block from {@link parseNodComments}: read the
 * claimed reviewer, verify the signature for that principal, then parse the
 * payload and make sure it names the same reviewer.
 */
export async function verifyNodBlock(
  block: NodBlock,
  options: { allowedSignersPath: string; sshKeygen?: string },
): Promise<BlockCheck> {
  const reviewer = claimedReviewer(block.payloadLine);
  if (!reviewer)
    return { ok: false, rejected: { reviewer: null, reason: "no valid reviewer in the payload" } };
  const sig = await verifyNod({ ...block, reviewer, ...options });
  if (!sig.ok)
    return { ok: false, rejected: { reviewer, reason: `signature invalid: ${sig.reason}` } };
  const decoded = decodePayload(block.payloadLine);
  if (!decoded.ok) return { ok: false, rejected: { reviewer, reason: decoded.reason } };
  if (decoded.payload.reviewer !== reviewer) {
    return {
      ok: false,
      rejected: { reviewer, reason: "payload reviewer differs from the verified principal" },
    };
  }
  return { ok: true, nod: { payload: decoded.payload, payloadLine: block.payloadLine } };
}

/**
 * Verifies many blocks (e.g. from every comment on a PR). Identical blocks
 * are checked once.
 */
export async function verifyNodBlocks(
  blocks: readonly NodBlock[],
  options: { allowedSignersPath: string; sshKeygen?: string },
): Promise<{ verified: VerifiedNod[]; rejected: RejectedNod[] }> {
  const seen = new Set<string>();
  const verified: VerifiedNod[] = [];
  const rejected: RejectedNod[] = [];
  for (const block of blocks) {
    const key = `${block.payloadLine}\n${block.signature}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const r = await verifyNodBlock(block, options);
    if (r.ok) verified.push(r.nod);
    else rejected.push(r.rejected);
  }
  return { verified, rejected };
}

/** One line of an `allowed_signers` file. */
export interface AllowedSigner {
  /** The principals (logins or patterns) the key may sign as. */
  principals: string[];
  /** Options such as `namespaces="nod"` or `valid-before=…`, unparsed. */
  options: string[];
  /** Key type, e.g. `ssh-ed25519`. */
  keyType: string;
  /** Base64 public key blob. */
  key: string;
}

/**
 * Parses an `allowed_signers` file (OpenSSH format: `principals [options]
 * keytype key [comment]`). Comments, blank and malformed lines are skipped.
 */
export function parseAllowedSigners(text: string): AllowedSigner[] {
  const signers: AllowedSigner[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const tokens = tokenize(line);
    const keyAt = tokens.findIndex((t, i) => i > 0 && KEY_TYPE_RE.test(t));
    if (keyAt < 1 || !tokens[keyAt + 1]) continue;
    signers.push({
      principals: unquote(tokens[0]!)
        .split(",")
        .map((p) => p.trim())
        .filter(Boolean),
      options: tokens.slice(1, keyAt).flatMap((t) => splitOptions(t)),
      keyType: tokens[keyAt]!,
      key: tokens[keyAt + 1]!,
    });
  }
  return signers;
}

/**
 * The logins enrolled in an `allowed_signers` file: every principal that is
 * a plain login (patterns are left out), deduplicated, in file order.
 */
export function enrolledLogins(text: string): string[] {
  const out: string[] = [];
  for (const s of parseAllowedSigners(text)) {
    for (const p of s.principals) if (LOGIN_RE.test(p) && !out.includes(p)) out.push(p);
  }
  return out;
}

/**
 * The principals a public key (`ssh-ed25519 AAAA… [comment]`) is enrolled
 * as, e.g. to tell whether the local signing key is enrolled yet.
 */
export function principalsForKey(text: string, publicKey: string): string[] {
  const [type, key] = publicKey.trim().split(/\s+/);
  return parseAllowedSigners(text)
    .filter((s) => s.keyType === type && s.key === key)
    .flatMap((s) => s.principals);
}

const KEY_TYPE_RE = /^(?:ssh-|ecdsa-|sk-|rsa-sha2-)/;

function tokenize(line: string): string[] {
  const tokens: string[] = [];
  let cur = "";
  let quoted = false;
  for (const ch of line) {
    if (ch === '"') quoted = !quoted;
    if (!quoted && (ch === " " || ch === "\t")) {
      if (cur) tokens.push(cur);
      cur = "";
    } else cur += ch;
  }
  if (cur) tokens.push(cur);
  return tokens;
}

function splitOptions(token: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quoted = false;
  for (const ch of token) {
    if (ch === '"') quoted = !quoted;
    if (!quoted && ch === ",") {
      if (cur) out.push(cur);
      cur = "";
    } else cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}

function unquote(s: string): string {
  return s.startsWith('"') && s.endsWith('"') ? s.slice(1, -1) : s;
}

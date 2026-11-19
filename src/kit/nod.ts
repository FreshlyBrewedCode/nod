/**
 * The nod format (ADR 0001): a one-line JSON payload, signed with SSHSIG
 * under the namespace `nod`, posted as a fenced `nod` block below a free-text
 * human line.
 *
 * Comment bodies are untrusted input. {@link parseNodComments} only cuts out
 * raw blocks; the JSON is read by {@link decodePayload}, which the verifier
 * calls only after `ssh-keygen` accepted the signature.
 */

/** The SSHSIG namespace every nod is signed under. */
export const NOD_NAMESPACE = "nod";

/**
 * A GitHub login, as accepted for `reviewer` and passed to `ssh-keygen -I`;
 * 39 characters at most:
 *
 * - a plain login: a letter or digit, then letters, digits and `-`;
 * - a managed user (Enterprise Managed Users; every account on GHE.com): the
 *   handle, one `_` and the enterprise's shortcode of 3 to 8 letters or
 *   digits, e.g. `mona-cat_octo` or the setup user `octo_admin`.
 *
 * Never whitespace, `*`, `?`, `!`, `,` or a leading `-`: `ssh-keygen` reads
 * the principals in `allowed_signers` as patterns, and `-I` takes this as an
 * argument.
 */
export const LOGIN_RE =
  /^(?=[A-Za-z0-9_-]{1,39}$)[A-Za-z0-9](?:[A-Za-z0-9-]*|(?:[A-Za-z0-9-]*[A-Za-z0-9])?_[A-Za-z0-9]{3,8})$/;

const REPO_NAME_RE = /^(?!\.\.?$)[A-Za-z0-9._-]{1,100}$/;

/** Whether `repo` is `owner/name`: the owner a {@link LOGIN_RE} login, the name GitHub's. */
export function isRepoName(repo: string): boolean {
  const parts = repo.split("/");
  return parts.length === 2 && LOGIN_RE.test(parts[0]!) && REPO_NAME_RE.test(parts[1]!);
}

/** Payloads longer than this (in bytes) are ignored. */
export const MAX_PAYLOAD_BYTES = 32 * 1024;

/** At most this many `nod` blocks are read from one comment. */
export const MAX_BLOCKS_PER_COMMENT = 20;

/** One PR a nod covers. A batch nod has several. */
export interface NodEntry {
  /** PR number in {@link NodPayload.repo}. */
  pr: number;
  /** The PR's base branch when it was signed. A retargeted PR needs a new nod. */
  base: string;
  /** The PR head commit that was reviewed. */
  head_sha: string;
  /** `git patch-id --stable` of the reviewed change (see `patchId`); `""` for an empty diff. */
  patch_id: string;
}

/**
 * `approve` is the only verdict that counts in v1. Anything else is carried
 * through so the UI can show it, and never satisfies a requirement.
 */
export type NodVerdict = "approve" | (string & {});

/** The signed statement. Field order here is the serialisation order. */
export interface NodPayload {
  v: 1;
  /** `owner/name`. A nod only counts in this repo. */
  repo: string;
  entries: NodEntry[];
  verdict: NodVerdict;
  /** `review` for a nod. Reserved for weaker or stronger attestations; the v1 policy does not read it. */
  level: string;
  /** GitHub login of the signer; the principal in `.nod/allowed_signers`. */
  reviewer: string;
  /** ISO 8601 time of signing. Informational: nods do not expire by time. */
  signed_at: string;
}

/** A `nod` block cut out of a comment, not yet verified. */
export interface NodBlock {
  /** The exact signed bytes: the payload line without a trailing newline. */
  payloadLine: string;
  /** The armored SSHSIG, ending with a newline. */
  signature: string;
}

/**
 * The canonical payload line: keys in the fixed order of ADR 0001, no
 * whitespace. The signature covers exactly these bytes, so the signer must
 * use this and the verifier never re-serialises what it verifies.
 *
 * Throws on a payload that could never verify (bad reviewer, PR number or
 * repo), so a signer fails before asking for a passphrase.
 */
export function serializePayload(payload: NodPayload): string {
  const problem = payloadProblem(payload);
  if (problem) throw new Error(`invalid nod payload: ${problem}`);
  return JSON.stringify({
    v: payload.v,
    repo: payload.repo,
    entries: payload.entries.map((e) => ({
      pr: e.pr,
      base: e.base,
      head_sha: e.head_sha,
      patch_id: e.patch_id,
    })),
    verdict: payload.verdict,
    level: payload.level,
    reviewer: payload.reviewer,
    signed_at: payload.signed_at,
  });
}

/**
 * The human line the signer puts above the block, e.g.
 * ``**nod** · approve · review · by `bob` · #2 #3``. It is not signed.
 */
export function nodHumanLine(payload: NodPayload): string {
  const prs = payload.entries.map((e) => `#${e.pr}`).join(" ");
  return `**nod** · ${payload.verdict} · ${payload.level} · by \`${payload.reviewer}\` · ${prs}`;
}

/**
 * The comment body for a nod: the human line, a blank line, then the fenced
 * `nod` block with the payload line and the armored signature. A batch nod
 * posts this same body on every PR it covers.
 */
export function renderNodComment(
  payloadLine: string,
  armoredSignature: string,
  humanLine: string,
): string {
  if (/[\r\n]/.test(payloadLine)) throw new Error("the payload line must be a single line");
  const sig = armoredSignature.replace(/\r/g, "").trim();
  return `${humanLine.trim()}\n\n\`\`\`nod\n${payloadLine}\n${sig}\n\`\`\`\n`;
}

// A fence at the start of a line, one JSON line, one armored SSHSIG, the closing fence.
const BLOCK_RE =
  /^```nod\n(\{[^\n]{0,32766}\})\n(-----BEGIN SSH SIGNATURE-----\n[A-Za-z0-9+/=\n]{1,8192}?-----END SSH SIGNATURE-----)\n```[ \t]*$/gm;

/**
 * Cuts the `nod` blocks out of one comment body. `\r` is stripped first
 * (web edits introduce CRLF), payloads above {@link MAX_PAYLOAD_BYTES} are
 * skipped and at most {@link MAX_BLOCKS_PER_COMMENT} blocks are returned.
 * Nothing is parsed or trusted here.
 */
export function parseNodComments(body: string): NodBlock[] {
  if (typeof body !== "string") return [];
  const text = body.replace(/\r/g, "");
  const blocks: NodBlock[] = [];
  for (const m of text.matchAll(BLOCK_RE)) {
    const payloadLine = m[1]!;
    if (Buffer.byteLength(payloadLine, "utf8") > MAX_PAYLOAD_BYTES) continue;
    blocks.push({ payloadLine, signature: `${m[2]!}\n` });
    if (blocks.length >= MAX_BLOCKS_PER_COMMENT) break;
  }
  return blocks;
}

// In the canonical line `reviewer` is the second-to-last key, directly before `signed_at`.
const REVIEWER_RE = /,"reviewer":"([^"\\]*)","signed_at":"/g;

/**
 * The login a payload line claims as its signer, read without parsing the
 * JSON, so it can be passed to `ssh-keygen -I`. `null` unless it occurs
 * exactly once and is a valid login. {@link decodePayload} later checks that
 * the verified payload says the same.
 */
export function claimedReviewer(payloadLine: string): string | null {
  const found = [...payloadLine.matchAll(REVIEWER_RE)];
  if (found.length !== 1) return null;
  const login = found[0]![1]!;
  return LOGIN_RE.test(login) ? login : null;
}

/** Result of {@link decodePayload}. */
export type DecodedPayload = { ok: true; payload: NodPayload } | { ok: false; reason: string };

/**
 * Parses a payload line **after its signature verified**. It must be valid
 * JSON of the v1 shape and in canonical form (re-serialising it gives the
 * same bytes), which rules out duplicate keys and extra fields.
 */
export function decodePayload(payloadLine: string): DecodedPayload {
  let value: unknown;
  try {
    value = JSON.parse(payloadLine);
  } catch {
    return { ok: false, reason: "payload is not JSON" };
  }
  if (!isRecord(value)) return { ok: false, reason: "payload is not an object" };
  if (value.v !== 1)
    return { ok: false, reason: `unsupported payload version ${JSON.stringify(value.v)}` };
  const problem = payloadProblem(value as unknown as NodPayload);
  if (problem) return { ok: false, reason: problem };
  const payload = value as unknown as NodPayload;
  if (serializePayload(payload) !== payloadLine)
    return { ok: false, reason: "payload is not in canonical form" };
  return { ok: true, payload };
}

const SHA_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const PATCH_ID_RE = /^(?:|[0-9a-f]{40}|[0-9a-f]{64})$/;

function payloadProblem(p: NodPayload): string | null {
  if (p.v !== 1) return "v must be 1";
  if (typeof p.repo !== "string" || !isRepoName(p.repo)) return "repo must be owner/name";
  if (!Array.isArray(p.entries) || p.entries.length === 0)
    return "entries must be a non-empty list";
  for (const e of p.entries) {
    if (!isRecord(e)) return "entry is not an object";
    if (!Number.isSafeInteger(e.pr) || (e.pr as number) <= 0)
      return "entry pr must be a positive integer";
    if (typeof e.base !== "string" || e.base.length === 0)
      return "entry base must be a branch name";
    if (typeof e.head_sha !== "string" || !SHA_RE.test(e.head_sha))
      return "entry head_sha must be a full commit SHA";
    if (typeof e.patch_id !== "string" || !PATCH_ID_RE.test(e.patch_id))
      return "entry patch_id must be hex or empty";
  }
  if (typeof p.verdict !== "string" || p.verdict.length === 0) return "verdict must be a string";
  if (typeof p.level !== "string" || p.level.length === 0) return "level must be a string";
  if (typeof p.reviewer !== "string" || !LOGIN_RE.test(p.reviewer))
    return "reviewer must be a GitHub login";
  if (typeof p.signed_at !== "string" || Number.isNaN(Date.parse(p.signed_at)))
    return "signed_at must be an ISO time";
  return null;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

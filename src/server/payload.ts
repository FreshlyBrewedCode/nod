/**
 * The nod payload line and the comment that carries it (ADR 0001). The
 * line is serialised here, once, in the ADR's key order; the signature is
 * over exactly its bytes. The kit's parser (`@frebreco/nod/kit`, later) reads
 * the same format on the verifier's side.
 */

import type { NodPayload } from "./source";

/** One line of JSON, keys in the ADR's order, no whitespace, no trailing newline. */
export function payloadLine(p: NodPayload): string {
  return JSON.stringify({
    v: p.v,
    repo: p.repo,
    entries: p.entries.map((e) => ({
      pr: e.pr,
      base: e.base,
      head_sha: e.head_sha,
      patch_id: e.patch_id,
    })),
    verdict: p.verdict,
    level: p.level,
    reviewer: p.reviewer,
    signed_at: p.signed_at,
  });
}

/** The free-text line above the block. Not signed; who posted the comment never matters. */
export function humanLine(p: NodPayload, note?: string): string {
  const prs = p.entries.map((e) => `#${e.pr}`).join(" ");
  const line = `**nod** · ${p.verdict} · ${p.level} · by \`${p.reviewer}\` · ${prs}`;
  // One line, and no fence of its own: the comment holds exactly one nod block.
  const extra = note?.replace(/`{3,}/g, "").replace(/\s+/g, " ").trim().slice(0, 500);
  return extra ? `${line}\n\n${extra}` : line;
}

/** The comment body: the human line, then a fenced `nod` block with the line and the armored signature. */
export function commentBody(line: string, signature: string, human: string): string {
  return `${human}\n\n\`\`\`nod\n${line}\n${signature.trim()}\n\`\`\`\n`;
}

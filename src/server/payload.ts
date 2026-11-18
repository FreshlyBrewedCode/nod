/**
 * The nod payload line and the comment that carries it (ADR 0001). The
 * format has one implementation, the kit's (`src/kit/nod.ts`), which the
 * repo's verifier uses too; this only adds the optional free-text note.
 */

import { nodHumanLine, renderNodComment, serializePayload } from "../kit/nod.ts";
import type { NodPayload } from "./source";

/**
 * One line of JSON, keys in the ADR's order, no whitespace, no trailing
 * newline. Throws on a payload that could never verify.
 */
export function payloadLine(p: NodPayload): string {
  return serializePayload({ ...p, entries: [...p.entries] });
}

/** The free-text line above the block, and the note. Not signed; who posted the comment never matters. */
export function humanLine(p: NodPayload, note?: string): string {
  const line = nodHumanLine({ ...p, entries: [...p.entries] });
  // One line, and no fence of its own: the comment holds exactly one nod block.
  const extra = note?.replace(/`{3,}/g, "").replace(/\s+/g, " ").trim().slice(0, 500);
  return extra ? `${line}\n\n${extra}` : line;
}

/** The comment body: the human line, then a fenced `nod` block with the line and the armored signature. */
export function commentBody(line: string, signature: string, human: string): string {
  return renderNodComment(line, signature, human);
}

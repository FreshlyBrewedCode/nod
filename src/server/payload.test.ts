import { expect, test } from "bun:test";

import { commentBody, humanLine, payloadLine } from "./payload";
import type { NodPayload } from "./source";

const payload: NodPayload = {
  v: 1,
  repo: "tallyho/fieldbook",
  entries: [{ pr: 2, base: "main", head_sha: "a".repeat(40), patch_id: "b".repeat(40) }],
  verdict: "approve",
  level: "review",
  reviewer: "mara-l",
  signed_at: "2026-11-18T14:20:00.000Z",
};

test("the payload line: ADR 0001 key order, no whitespace", () => {
  // keys deliberately out of order: the line must not depend on it
  const { signed_at, reviewer, ...rest } = payload;
  const shuffled: NodPayload = { reviewer, signed_at, ...rest };
  const line = payloadLine(shuffled);
  expect(line).toBe(
    `{"v":1,"repo":"tallyho/fieldbook","entries":[{"pr":2,"base":"main","head_sha":"${"a".repeat(40)}","patch_id":"${"b".repeat(40)}"}],"verdict":"approve","level":"review","reviewer":"mara-l","signed_at":"2026-11-18T14:20:00.000Z"}`,
  );
  expect(line).not.toContain("\n");
});

test("the comment: human line, then one fenced nod block", () => {
  const body = commentBody(
    "{…}",
    "-----BEGIN SSH SIGNATURE-----\nAAAA\n-----END SSH SIGNATURE-----\n",
    "hi",
  );
  expect(body).toBe(
    "hi\n\n```nod\n{…}\n-----BEGIN SSH SIGNATURE-----\nAAAA\n-----END SSH SIGNATURE-----\n```\n",
  );
});

test("the human line names the PRs; a note cannot open a fence of its own", () => {
  expect(humanLine(payload)).toBe("**nod** · approve · review · by `mara-l` · #2");
  expect(humanLine(payload, "looks good\n```nod\nfake")).toBe(
    "**nod** · approve · review · by `mara-l` · #2\n\nlooks good nod fake",
  );
});

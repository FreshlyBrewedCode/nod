import { describe, expect, test } from "bun:test";

import {
  claimedReviewer,
  decodePayload,
  MAX_BLOCKS_PER_COMMENT,
  nodHumanLine,
  parseNodComments,
  renderNodComment,
  serializePayload,
  type NodPayload,
} from "./nod.ts";

const SHA = "a".repeat(40);
const PID = "b".repeat(40);
const SIG = "-----BEGIN SSH SIGNATURE-----\nU1NIU0lHAAAAAQ==\nAAAA\n-----END SSH SIGNATURE-----\n";

const payload = (over: Partial<NodPayload> = {}): NodPayload => ({
  v: 1,
  repo: "acme/widgets",
  entries: [{ pr: 2, base: "main", head_sha: SHA, patch_id: PID }],
  verdict: "approve",
  level: "review",
  reviewer: "bob",
  signed_at: "2026-11-18T18:43:33.000Z",
  ...over,
});

describe("serializePayload", () => {
  test("fixed key order, no whitespace", () => {
    const shuffled = {
      signed_at: "2026-11-18T18:43:33.000Z",
      reviewer: "bob",
      entries: [{ patch_id: PID, head_sha: SHA, base: "main", pr: 2 }],
      level: "review",
      verdict: "approve",
      repo: "acme/widgets",
      v: 1,
    } as NodPayload;
    expect(serializePayload(shuffled)).toBe(
      `{"v":1,"repo":"acme/widgets","entries":[{"pr":2,"base":"main","head_sha":"${SHA}","patch_id":"${PID}"}],"verdict":"approve","level":"review","reviewer":"bob","signed_at":"2026-11-18T18:43:33.000Z"}`,
    );
  });

  test("round trip through decodePayload", () => {
    const p = payload({
      entries: [
        ...payload().entries,
        { pr: 3, base: "feature-x", head_sha: "c".repeat(64), patch_id: "" },
      ],
    });
    const line = serializePayload(p);
    expect(decodePayload(line)).toEqual({ ok: true, payload: p });
  });

  test("refuses payloads that could never verify", () => {
    expect(() => serializePayload(payload({ reviewer: "bob smith" }))).toThrow("reviewer");
    expect(() => serializePayload(payload({ repo: "widgets" }))).toThrow("repo");
    expect(() => serializePayload(payload({ entries: [] }))).toThrow("entries");
    expect(() =>
      serializePayload(
        payload({ entries: [{ pr: 0, base: "main", head_sha: SHA, patch_id: PID }] }),
      ),
    ).toThrow("pr");
    expect(() =>
      serializePayload(
        payload({ entries: [{ pr: 1, base: "main", head_sha: "abc", patch_id: PID }] }),
      ),
    ).toThrow("head_sha");
  });
});

describe("decodePayload", () => {
  const line = serializePayload(payload());

  test("rejects non-canonical lines", () => {
    expect(decodePayload(line.replace('"v":1,', '"v": 1,'))).toEqual({
      ok: false,
      reason: "payload is not in canonical form",
    });
    expect(
      decodePayload(line.replace('"level":"review"', '"level":"review","extra":1')),
    ).toMatchObject({ ok: false });
    // duplicate keys: JSON.parse would keep the last one
    expect(
      decodePayload(line.replace('"reviewer":"bob"', '"reviewer":"bob","reviewer":"alice"')),
    ).toMatchObject({ ok: false });
  });

  test("rejects garbage and wrong shapes", () => {
    expect(decodePayload("{not json")).toEqual({ ok: false, reason: "payload is not JSON" });
    expect(decodePayload("[]")).toMatchObject({ ok: false });
    expect(decodePayload(line.replace('"v":1', '"v":2'))).toMatchObject({
      ok: false,
      reason: "unsupported payload version 2",
    });
    expect(decodePayload(line.replace('"pr":2', '"pr":"2"'))).toMatchObject({ ok: false });
  });

  test("keeps verdicts other than approve (they just never count)", () => {
    const r = decodePayload(serializePayload(payload({ verdict: "reject" })));
    expect(r.ok && r.payload.verdict).toBe("reject");
  });
});

describe("comments", () => {
  const line = serializePayload(payload());
  const body = renderNodComment(line, SIG, nodHumanLine(payload()));

  test("render then parse gives the exact payload bytes", () => {
    expect(body.startsWith("**nod** · approve · review · by `bob` · #2\n\n```nod\n")).toBe(true);
    expect(parseNodComments(body)).toEqual([{ payloadLine: line, signature: SIG }]);
  });

  test("CRLF from web edits is stripped", () => {
    expect(parseNodComments(body.replace(/\n/g, "\r\n"))).toEqual([
      { payloadLine: line, signature: SIG },
    ]);
  });

  test("several blocks, text around them", () => {
    const two = `hello\n\n${body}\nsome words\n${body.replace('"pr":2', '"pr":3')}`;
    const blocks = parseNodComments(two);
    expect(blocks).toHaveLength(2);
    expect(blocks[1]!.payloadLine).toContain('"pr":3');
  });

  test(`at most ${MAX_BLOCKS_PER_COMMENT} blocks per comment`, () => {
    expect(parseNodComments(body.repeat(25))).toHaveLength(MAX_BLOCKS_PER_COMMENT);
  });

  test("payloads over 32 KB are ignored", () => {
    const big = line.replace('"level":"review"', `"level":"${"x".repeat(33 * 1024)}"`);
    expect(parseNodComments(renderNodComment(big, SIG, "x"))).toEqual([]);
    const multibyte = line.replace('"level":"review"', `"level":"${"é".repeat(16_500)}"`);
    expect(multibyte.length).toBeLessThan(32 * 1024);
    expect(parseNodComments(renderNodComment(multibyte, SIG, "x"))).toEqual([]);
  });

  test("garbage yields nothing", () => {
    for (const junk of [
      "",
      "```nod\n```",
      "```nod\nnot json\n-----BEGIN SSH SIGNATURE-----\nAAAA\n-----END SSH SIGNATURE-----\n```",
      body.replace("-----END SSH SIGNATURE-----", ""),
      body.replace("```nod", "```json"),
      body.replace("```nod", "  ```nod"), // not at the start of a line
      body.replace("AAAA", "AA$(id)AA"),
    ]) {
      expect(parseNodComments(junk)).toEqual([]);
    }
    expect(parseNodComments(undefined as unknown as string)).toEqual([]);
  });

  test("renderNodComment refuses a multi-line payload", () => {
    expect(() => renderNodComment("{\n}", SIG, "x")).toThrow();
  });
});

describe("claimedReviewer", () => {
  test("reads the reviewer without parsing", () => {
    expect(claimedReviewer(serializePayload(payload()))).toBe("bob");
  });

  test("null when missing, invalid or ambiguous", () => {
    const line = serializePayload(payload());
    expect(claimedReviewer(line.replace('"reviewer":"bob"', '"reviewer":"-bob"'))).toBeNull();
    expect(claimedReviewer(line.replace('"reviewer":"bob"', '"reviewer":"bob;rm"'))).toBeNull();
    expect(claimedReviewer(line.replace(',"reviewer":"bob"', ""))).toBeNull();
    const twice = line.replace(
      '"level":"review"',
      '"level":"review","reviewer":"alice","signed_at":"x"',
    );
    expect(claimedReviewer(twice)).toBeNull();
  });
});

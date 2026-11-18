import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { parseNodComments, renderNodComment, serializePayload, type NodPayload } from "./nod.ts";
import {
  enrolledLogins,
  parseAllowedSigners,
  principalsForKey,
  verifyNod,
  verifyNodBlock,
  verifyNodBlocks,
} from "./sshsig.ts";
import { makeKey, sshSign, tempDir } from "./test-support.ts";

const payload = (over: Partial<NodPayload> = {}): NodPayload => ({
  v: 1,
  repo: "acme/widgets",
  entries: [{ pr: 2, base: "main", head_sha: "a".repeat(40), patch_id: "b".repeat(40) }],
  verdict: "approve",
  level: "review",
  reviewer: "bob",
  signed_at: "2026-11-18T18:43:33.000Z",
  ...over,
});

let dir = "";
let cleanup = async () => {};
let allowedSignersPath = "";
let alice = { privateKey: "", publicKey: "" };
let bob = { privateKey: "", publicKey: "" };
let mallory = { privateKey: "", publicKey: "" };

beforeAll(async () => {
  ({ dir, cleanup } = await tempDir());
  alice = await makeKey(dir, "alice");
  bob = await makeKey(dir, "bob");
  mallory = await makeKey(dir, "mallory"); // not enrolled
  allowedSignersPath = join(dir, "allowed_signers");
  await writeFile(
    allowedSignersPath,
    `# nod signers\nalice ${alice.publicKey}\nbob namespaces="nod" ${bob.publicKey}\n`,
  );
});

afterAll(() => cleanup());

describe("verifyNod with the real ssh-keygen", () => {
  test("a good signature verifies", async () => {
    const line = serializePayload(payload());
    const signature = await sshSign(bob.privateKey, line);
    expect(
      await verifyNod({ payloadLine: line, signature, reviewer: "bob", allowedSignersPath }),
    ).toEqual({ ok: true });
  });

  test("wrong key: alice's key, payload claims bob", async () => {
    const line = serializePayload(payload());
    const signature = await sshSign(alice.privateKey, line);
    const r = await verifyNod({
      payloadLine: line,
      signature,
      reviewer: "bob",
      allowedSignersPath,
    });
    expect(r.ok).toBe(false);
  });

  test("a key that is not enrolled", async () => {
    const line = serializePayload(payload({ reviewer: "mallory" }));
    const signature = await sshSign(mallory.privateKey, line);
    expect(
      (await verifyNod({ payloadLine: line, signature, reviewer: "mallory", allowedSignersPath }))
        .ok,
    ).toBe(false);
  });

  test("wrong namespace", async () => {
    const line = serializePayload(payload());
    const signature = await sshSign(bob.privateKey, line, "git");
    const r = await verifyNod({
      payloadLine: line,
      signature,
      reviewer: "bob",
      allowedSignersPath,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("namespace");
  });

  test("tampered payload", async () => {
    const line = serializePayload(payload());
    const signature = await sshSign(bob.privateKey, line);
    const tampered = line.replace('"pr":2', '"pr":6');
    expect(
      (await verifyNod({ payloadLine: tampered, signature, reviewer: "bob", allowedSignersPath }))
        .ok,
    ).toBe(false);
    // a trailing newline is a different message too
    expect(
      (
        await verifyNod({
          payloadLine: `${line}\n`,
          signature,
          reviewer: "bob",
          allowedSignersPath,
        })
      ).ok,
    ).toBe(false);
  });

  test("wrong principal", async () => {
    const line = serializePayload(payload());
    const signature = await sshSign(bob.privateKey, line);
    expect(
      (await verifyNod({ payloadLine: line, signature, reviewer: "alice", allowedSignersPath })).ok,
    ).toBe(false);
  });

  test("an invalid login never reaches ssh-keygen", async () => {
    const r = await verifyNod({
      payloadLine: "{}",
      signature: "x",
      reviewer: "-a",
      allowedSignersPath,
    });
    expect(r).toEqual({ ok: false, reason: "reviewer is not a valid login" });
  });
});

describe("verifyNodBlock", () => {
  test("parse, verify, decode", async () => {
    const line = serializePayload(payload());
    const body = renderNodComment(line, await sshSign(bob.privateKey, line), "**nod**");
    const [block] = parseNodComments(body.replace(/\n/g, "\r\n"));
    const r = await verifyNodBlock(block!, { allowedSignersPath });
    expect(r).toEqual({ ok: true, nod: { payload: payload(), payloadLine: line } });
  });

  test("a signed but non-canonical payload is rejected after verification", async () => {
    const line = serializePayload(payload()).replace('"v":1,', '"v": 1,');
    const r = await verifyNodBlock(
      { payloadLine: line, signature: await sshSign(bob.privateKey, line) },
      { allowedSignersPath },
    );
    expect(r).toEqual({
      ok: false,
      rejected: { reviewer: "bob", reason: "payload is not in canonical form" },
    });
  });

  test("verifyNodBlocks dedupes identical blocks and sorts results", async () => {
    const good = serializePayload(payload());
    const goodSig = await sshSign(bob.privateKey, good);
    const forged = serializePayload(payload({ reviewer: "alice" }));
    const forgedSig = await sshSign(bob.privateKey, forged);
    const r = await verifyNodBlocks(
      [
        { payloadLine: good, signature: goodSig },
        { payloadLine: good, signature: goodSig },
        { payloadLine: forged, signature: forgedSig },
      ],
      { allowedSignersPath },
    );
    expect(r.verified).toHaveLength(1);
    expect(r.rejected).toHaveLength(1);
    expect(r.rejected[0]!.reviewer).toBe("alice");
    expect(r.rejected[0]!.reason).toStartWith("signature invalid");
  });
});

describe("allowed_signers helpers", () => {
  const text = [
    "# comment",
    "",
    `alice ssh-ed25519 AAAAalice alice@laptop`,
    `bob,Bob namespaces="nod",valid-after="20260101" ssh-ed25519 AAAAbob`,
    `"carol" cert-authority ssh-ed25519 AAAAcarol`,
    `*@example.com ssh-ed25519 AAAAwild`,
    "broken line",
  ].join("\n");

  test("parse", () => {
    const signers = parseAllowedSigners(text);
    expect(signers).toHaveLength(4);
    expect(signers[1]).toEqual({
      principals: ["bob", "Bob"],
      options: ['namespaces="nod"', 'valid-after="20260101"'],
      keyType: "ssh-ed25519",
      key: "AAAAbob",
    });
    expect(signers[2]!.principals).toEqual(["carol"]);
  });

  test("enrolled logins skip patterns and duplicates", () => {
    expect(enrolledLogins(text)).toEqual(["alice", "bob", "Bob", "carol"]);
  });

  test("principals for a key", () => {
    expect(principalsForKey(text, "ssh-ed25519 AAAAbob bob@desk")).toEqual(["bob", "Bob"]);
    expect(principalsForKey(text, "ssh-ed25519 AAAAnobody")).toEqual([]);
  });
});

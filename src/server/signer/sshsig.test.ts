/**
 * Every signature here is checked by the real `ssh-keygen`: directly, and
 * through the kit's `verifyNod`, as a repo's verifier does. Temp dirs only.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  parseNodComments,
  renderNodComment,
  serializePayload,
  type NodPayload,
} from "../../kit/nod.ts";
import { verifyNod, verifyNodBlock } from "../../kit/sshsig.ts";
import { makeKey, tempDir } from "../../kit/test-support.ts";
import { ed25519Method, publicKeyOfSeed } from "./ed25519";
import { allowedSignersLine, fingerprint } from "./ssh-wire";
import { armor, signSshsig } from "./sshsig";
import { sshKeygen, sshKeygenSign, testKey, writeOpensshKey } from "./test-support";

const payload = (over: Partial<NodPayload> = {}): NodPayload => ({
  v: 1,
  repo: "tallyho/fieldbook",
  entries: [{ pr: 482, base: "main", head_sha: "a".repeat(40), patch_id: "b".repeat(40) }],
  verdict: "approve",
  level: "review",
  reviewer: "mara-l",
  signed_at: "2026-11-18T14:20:00.000Z",
  ...over,
});

const batch = serializePayload(
  payload({
    entries: [
      { pr: 482, base: "main", head_sha: "a".repeat(40), patch_id: "b".repeat(40) },
      { pr: 488, base: "main", head_sha: "c".repeat(40), patch_id: "" },
      { pr: 490, base: "release/2.x", head_sha: "d".repeat(64), patch_id: "e".repeat(64) },
    ],
  }),
);
// The base is the one free-text field the payload carries: emoji, umlauts, CJK.
const nonAscii = serializePayload(
  payload({
    entries: [{ pr: 7, base: "größe/👍-测试", head_sha: "f".repeat(40), patch_id: "0".repeat(40) }],
  }),
);

let dir = "";
let cleanup = async () => {};
let allowedSignersPath = "";
const me = testKey();
const method = ed25519Method(me.seed);
let other = { privateKey: "", publicKey: "" };

beforeAll(async () => {
  ({ dir, cleanup } = await tempDir("nod-sshsig-"));
  other = await makeKey(dir, "jonas");
  allowedSignersPath = join(dir, "allowed_signers");
  await writeFile(
    allowedSignersPath,
    `${allowedSignersLine("mara-l", me.publicKey)}\njonas-w ${other.publicKey}\n`,
  );
});

afterAll(() => cleanup());

const check = (payloadLine: string, signature: string, reviewer = "mara-l") =>
  verifyNod({ payloadLine, signature, reviewer, allowedSignersPath });

describe("our SSHSIG, verified by ssh-keygen", () => {
  test("ssh-keygen -Y verify, called directly, accepts it and names our fingerprint", async () => {
    const line = serializePayload(payload());
    const signature = await signSshsig(line, method);
    const sigPath = join(dir, "direct.sig");
    await writeFile(sigPath, signature);
    const r = await sshKeygen(
      ["-Y", "verify", "-f", allowedSignersPath, "-I", "mara-l", "-n", "nod", "-s", sigPath],
      line,
    );
    expect(r.status).toBe(0);
    expect(r.stdout + r.stderr).toContain(
      `Good "nod" signature for mara-l with ED25519 key ${fingerprint(me.blob)}`,
    );
  });

  test("a payload line verifies through the kit", async () => {
    const line = serializePayload(payload());
    expect(await check(line, await signSshsig(line, method))).toEqual({ ok: true });
  });

  test("a multi-entry batch line verifies, from the rendered comment", async () => {
    const body = renderNodComment(batch, await signSshsig(batch, method), "**nod** · batch");
    const [block] = parseNodComments(body);
    expect(block!.payloadLine).toBe(batch);
    const r = await verifyNodBlock(block!, { allowedSignersPath });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.nod.payload.entries.map((e) => e.pr)).toEqual([482, 488, 490]);
  });

  test("non-ASCII in the payload verifies: the message is the UTF-8 bytes", async () => {
    expect(nonAscii).toContain("größe/👍-测试");
    expect(await check(nonAscii, await signSshsig(nonAscii, method))).toEqual({ ok: true });
  });

  test("the wrong namespace fails", async () => {
    const line = serializePayload(payload());
    const r = await check(line, await signSshsig(line, method, "git"));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("namespace");
  });

  test("a tampered message fails, a trailing newline too", async () => {
    const line = serializePayload(payload());
    const signature = await signSshsig(line, method);
    expect((await check(line.replace('"pr":482', '"pr":483'), signature)).ok).toBe(false);
    expect((await check(`${line}\n`, signature)).ok).toBe(false);
  });

  test("another key fails: not enrolled, or enrolled under another login", async () => {
    const line = serializePayload(payload());
    const stranger = ed25519Method(testKey().seed);
    expect((await check(line, await signSshsig(line, stranger))).ok).toBe(false);
    // our signature, checked as jonas-w's
    expect((await check(line, await signSshsig(line, method), "jonas-w")).ok).toBe(false);
  });

  test("a tampered signature fails", async () => {
    const line = serializePayload(payload());
    const signature = await signSshsig(line, method);
    const body = signature.split("\n")[2]!;
    const flipped = signature.replace(
      body,
      body.slice(0, 10) + (body[10] === "A" ? "B" : "A") + body.slice(11),
    );
    expect((await check(line, flipped)).ok).toBe(false);
  });
});

describe("byte for byte what ssh-keygen -Y sign writes", () => {
  test("the same key and message give the identical armored signature", async () => {
    const keyPath = await writeOpensshKey(dir, me.seed, publicKeyOfSeed(me.seed));
    // ssh-keygen reads the key file as ours: same public key.
    const pub = await sshKeygen(["-y", "-f", keyPath]);
    expect(pub.stdout.trim().split(" ").slice(0, 2)).toEqual(me.publicKey.split(" ").slice(0, 2));
    const messages = [
      serializePayload(payload()),
      batch,
      nonAscii,
      "nod test signature · mara-l · 2026-11-18T14:20:00.000Z",
      "",
      "x".repeat(5000),
    ];
    for (const message of messages) {
      const theirs = await sshKeygenSign(dir, keyPath, message);
      expect(await signSshsig(message, method)).toBe(theirs);
    }
    expect(await signSshsig("ns", method, "other")).toBe(
      await sshKeygenSign(dir, keyPath, "ns", "other"),
    );
  });

  test("the fingerprint is ssh-keygen -l's", async () => {
    const pubPath = join(dir, "me.pub");
    await writeFile(pubPath, `${me.publicKey}\n`);
    const r = await sshKeygen(["-l", "-f", pubPath]);
    expect(r.stdout).toContain(fingerprint(me.blob));
  });
});

test("the armor wraps base64 at 70 columns and ends with a newline", async () => {
  const text = armor(Buffer.alloc(200, 7));
  const lines = text.split("\n");
  expect(lines[0]).toBe("-----BEGIN SSH SIGNATURE-----");
  expect(lines.at(-2)).toBe("-----END SSH SIGNATURE-----");
  expect(lines.at(-1)).toBe("");
  expect(lines.slice(1, -2).every((l) => l.length <= 70)).toBe(true);
  expect(lines[1]!.length).toBe(70);
  expect(Buffer.from(lines.slice(1, -2).join(""), "base64")).toEqual(Buffer.alloc(200, 7));
});

test("a disposed method signs nothing", async () => {
  const m = ed25519Method(testKey().seed);
  m.dispose();
  await expect(signSshsig("line", m)).rejects.toThrow("disposed");
});

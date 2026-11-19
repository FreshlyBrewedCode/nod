/**
 * Enterprise Managed Users (every account on GHE.com) have logins like
 * `mona_acme`: the handle, `_` and the enterprise's shortcode. Their nods
 * must work end to end, with the real `ssh-keygen`, and the login pattern
 * must stay strict enough to be passed to `ssh-keygen -I`.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { evaluateNods } from "./evaluate.ts";
import {
  isRepoName,
  LOGIN_RE,
  parseNodComments,
  renderNodComment,
  serializePayload,
  type NodPayload,
} from "./nod.ts";
import { peer, self } from "./requirement.ts";
import { enrolledLogins, verifyNod, verifyNodBlocks } from "./sshsig.ts";
import { makeKey, sshSign, tempDir } from "./test-support.ts";

describe("LOGIN_RE", () => {
  test("plain logins, as before", () => {
    for (const ok of ["a", "bob", "mona-cat", "A1", "x".repeat(39)])
      expect(LOGIN_RE.test(ok), ok).toBe(true);
  });

  test("managed users: handle, one underscore, a shortcode of 3 to 8", () => {
    for (const ok of [
      "mona_acme",
      "Mona-Cat_octo",
      "m_abc",
      "octo_admin", // the setup user: SHORT-CODE_admin
      "2abvd19d_admin",
      "mona_2abvd19d",
      `${"a".repeat(31)}_octocat`, // 39 in all
    ])
      expect(LOGIN_RE.test(ok), ok).toBe(true);
  });

  test("still strict: nothing ssh-keygen or a shell could read as more than a name", () => {
    for (const bad of [
      "",
      "_acme",
      "mona_",
      "mona_ac", // shortcode too short
      "mona_acmeacmea", // too long
      "mona__acme",
      "mona_ac_me",
      "mona-_acme",
      "mona_ac-me",
      `${"a".repeat(32)}_octocat`, // 40
      "-mona_acme",
      "mona acme",
      "mona_acme\n",
      "mona_*",
      "mona_ac?e",
      "*_acme",
      "!mona_acme",
      "mona_acme,bob",
      "mona.acme",
      "mona/acme",
      "mona_acmé",
    ])
      expect(LOGIN_RE.test(bad), JSON.stringify(bad)).toBe(false);
  });

  test("repos owned by a managed user", () => {
    expect(isRepoName("mona_acme/widgets")).toBe(true);
    expect(isRepoName("acme/widgets")).toBe(true);
    expect(isRepoName("mona_*/widgets")).toBe(false);
    expect(isRepoName("acme/..")).toBe(false);
    expect(isRepoName("acme/widgets/x")).toBe(false);
  });
});

describe("a managed user's nod, end to end with ssh-keygen", () => {
  let dir = "";
  let cleanup = async () => {};
  let allowedSignersPath = "";
  let mona = { privateKey: "", publicKey: "" };
  let hubot = { privateKey: "", publicKey: "" };
  let monb = { privateKey: "", publicKey: "" };

  const payload = (reviewer: string): NodPayload => ({
    v: 1,
    repo: "mona_acme/widgets",
    entries: [{ pr: 7, base: "main", head_sha: "c".repeat(40), patch_id: "d".repeat(40) }],
    verdict: "approve",
    level: "review",
    reviewer,
    signed_at: "2026-11-19T09:00:00.000Z",
  });

  beforeAll(async () => {
    ({ dir, cleanup } = await tempDir());
    mona = await makeKey(dir, "mona");
    hubot = await makeKey(dir, "hubot");
    monb = await makeKey(dir, "monb");
    allowedSignersPath = join(dir, "allowed_signers");
    await writeFile(
      allowedSignersPath,
      [
        `mona_acme namespaces="nod" ${mona.publicKey}`,
        `hubot_acme namespaces="nod" ${hubot.publicKey}`,
        // A pattern principal: ssh-keygen would match mon?_acme against it.
        `mon?_acme namespaces="nod" ${monb.publicKey}`,
        "",
      ].join("\n"),
    );
  });
  afterAll(() => cleanup());

  test("signed with ssh-keygen -Y sign as mona_acme, it verifies as mona_acme only", async () => {
    const line = serializePayload(payload("mona_acme"));
    const signature = await sshSign(mona.privateKey, line);
    const as = (reviewer: string) =>
      verifyNod({ payloadLine: line, signature, reviewer, allowedSignersPath });
    expect(await as("mona_acme")).toEqual({ ok: true });
    expect((await as("hubot_acme")).ok).toBe(false);
    expect((await as("mona_acmf")).ok).toBe(false);
    // The pattern-like logins never reach ssh-keygen.
    expect(await as("mona_*")).toEqual({ ok: false, reason: "reviewer is not a valid login" });
    expect(await as("mon?_acme")).toEqual({ ok: false, reason: "reviewer is not a valid login" });
  });

  test("a pattern principal is not an enrolled login", async () => {
    const text = await Bun.file(allowedSignersPath).text();
    expect(enrolledLogins(text)).toEqual(["mona_acme", "hubot_acme"]);
  });

  test("self and peer, case-insensitively, from the comments", async () => {
    const comment = async (key: string, reviewer: string) => {
      const line = serializePayload(payload(reviewer));
      return renderNodComment(line, await sshSign(key, line), `**nod** · by \`${reviewer}\``);
    };
    const blocks = [
      ...parseNodComments(await comment(mona.privateKey, "mona_acme")),
      ...parseNodComments(await comment(hubot.privateKey, "hubot_acme")),
    ];
    const { verified, rejected } = await verifyNodBlocks(blocks, { allowedSignersPath });
    expect(rejected).toEqual([]);
    expect(verified.map((v) => v.payload.reviewer)).toEqual(["mona_acme", "hubot_acme"]);

    // GitHub reports the author as the account spells it; the case may differ.
    const pr = {
      repo: "Mona_Acme/widgets",
      number: 7,
      author: "Mona_Acme",
      base: "main",
      head_sha: "c".repeat(40),
      patch_id: "d".repeat(40),
    };
    const own = evaluateNods({ pr, requirement: self, verified: verified.slice(0, 1), rejected });
    expect(own.nods[0]).toMatchObject({ reviewer: "mona_acme", role: "self", counts: true });
    expect(own.satisfied).toBe(true);
    const onlyMine = evaluateNods({
      pr,
      requirement: peer,
      verified: verified.slice(0, 1),
      rejected,
    });
    expect(onlyMine.satisfied).toBe(false);
    const both = evaluateNods({ pr, requirement: peer, verified, rejected });
    expect(both.nods.map((n) => [n.reviewer, n.role])).toEqual([
      ["mona_acme", "self"],
      ["hubot_acme", "peer"],
    ]);
    expect(both.satisfied).toBe(true);
  });
});

/**
 * The session with the real signer and the fake source: what it posts is a
 * nod the repo's verifier accepts (the kit's parser, then `ssh-keygen`).
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { parseNodComments } from "../kit/nod.ts";
import { verifyNodBlock } from "../kit/sshsig.ts";
import { tempDir } from "../kit/test-support.ts";
import type { PrView, Reply, ServerToClient, Snapshot } from "../shared/protocol";
import { ManualClock } from "./clock";
import { FakeSource } from "./fake-source";
import { Session } from "./session";
import { start } from "./start";
import { KeyFileSigner } from "./signer/key-file-signer";
import { createKeyFile } from "./signer/key-store";
import { allowedSignersLine } from "./signer/ssh-wire";
import type { FakeScenario } from "./fake-source";
import type { PostNodInput } from "./source";

const NOW = Date.UTC(2026, 10, 18, 14, 20);
const CHEAP = { N: 2 ** 10, r: 8, p: 1 };
const PASS = "correct horse battery";
const R = "tallyho/fieldbook";

let dir = "";
let cleanup = async () => {};
beforeEach(async () => ({ dir, cleanup } = await tempDir("nod-session-signer-")));
afterEach(() => cleanup());

async function setup(scenario: FakeScenario, withKey: boolean) {
  const file = join(dir, "nod", "signing-key.json");
  const created = withKey ? await createKeyFile(file, PASS, { scrypt: CHEAP }) : null;
  const clock = new ManualClock(NOW);
  const source = new FakeSource({
    clock,
    scenario,
    ...(created && { myKey: created.record.publicKey }),
  });
  const posted: PostNodInput[] = [];
  const post = source.postNod.bind(source);
  source.postNod = async (input) => {
    posted.push(input);
    return post(input);
  };
  const signer = new KeyFileSigner({ clock, file, scrypt: CHEAP, wrongPassphraseDelayMs: 0 });
  const session = new Session({ source, signer, clock, version: null, fake: false });
  const messages: ServerToClient[] = [];
  const client = {
    side: "loopback" as const,
    send: (data: string) => void messages.push(JSON.parse(data)),
  };
  await session.attach(client);
  let id = 0;
  const ask = async (t: string, body: Record<string, unknown> = {}): Promise<Reply> => {
    const rid = `q${++id}`;
    await session.handle(client, JSON.stringify({ ...body, t, id: rid }));
    return messages.find((m) => m.t === "reply" && m.id === rid) as Reply;
  };
  const pr = (n: number) =>
    (messages.filter((m) => m.t === "snapshot").at(-1) as Snapshot).prs.find(
      (p) => p.number === n,
    ) as PrView;
  const lastSigner = () => messages.filter((m) => m.t === "signer").at(-1);
  const lastRepos = () => messages.filter((m) => m.t === "repos").at(-1);
  const at = (repo: string, n: number) =>
    (messages.filter((m) => m.t === "snapshot").at(-1) as Snapshot).prs.find(
      (p) => p.repo === repo && p.number === n,
    ) as PrView;
  return { file, created, source, signer, session, ask, pr, at, posted, lastSigner, lastRepos };
}

const ok = (reply: Reply) => {
  if (!reply.ok) throw new Error(`${reply.to} failed: ${reply.error.code} ${reply.error.message}`);
  return reply.result as never;
};
const err = (reply: Reply) => (reply.ok ? "ok" : reply.error.code);

test("unlock, sign a batch: the posted comment parses with the kit and verifies with ssh-keygen", async () => {
  const { created, ask, pr, posted } = await setup("team", true);
  expect(err(await ask("unlock", { passphrase: "not it" }))).toBe("bad-passphrase");
  ok(await ask("unlock", { passphrase: PASS }));
  const result = ok(
    await ask("sign", {
      entries: [
        { repo: R, pr: 482, head_sha: pr(482).headSha },
        { repo: R, pr: 488, head_sha: pr(488).headSha },
      ],
      verdict: "approve",
      note: "Billing looks right.",
    }),
  ) as { payloads: { payload: string }[]; posted: { pr: number }[] };
  expect(result.posted.map((p) => p.pr)).toEqual([482, 488]);
  expect(posted).toHaveLength(1);

  const body = posted[0]!.body;
  expect(
    body.startsWith(
      "**nod** · approve · review · by `mara-l` · #482 #488\n\nBilling looks right.\n\n```nod\n",
    ),
  ).toBe(true);
  const blocks = parseNodComments(body);
  expect(blocks).toHaveLength(1);
  expect(blocks[0]!.payloadLine).toBe(result.payloads[0]!.payload);

  const allowedSignersPath = join(dir, "allowed_signers");
  await writeFile(
    allowedSignersPath,
    `${allowedSignersLine("mara-l", created!.record.publicKey)}\n`,
  );
  const verified = await verifyNodBlock(blocks[0]!, { allowedSignersPath });
  expect(verified.ok).toBe(true);
  if (verified.ok)
    expect(verified.nod.payload).toMatchObject({
      repo: "tallyho/fieldbook",
      reviewer: "mara-l",
      entries: [{ pr: 482 }, { pr: 488 }],
    });
});

test("onboarding with the real key: create over the socket, test signature verified by ssh-keygen", async () => {
  const { file, ask, lastSigner, lastRepos } = await setup("join", false);
  expect(err(await ask("create-key", { passphrase: "short" }))).toBe("weak-passphrase");
  const { key } = ok(await ask("create-key", { passphrase: PASS })) as {
    key: { publicKey: string; location: string };
  };
  expect(key).toMatchObject({ location: file });
  expect(key).not.toHaveProperty("enrolment");
  await Promise.resolve();
  expect(lastRepos()).toMatchObject({ repos: [{ enrolment: { state: "not-enrolled" } }] });
  expect(err(await ask("create-key", { passphrase: PASS }))).toBe("key-exists");
  expect(lastSigner()).toMatchObject({ signer: { state: "locked" } });

  // enrolment compares the key, not the comment
  const { pr } = ok(await ask("open-enrol-pr", { repo: R })) as { pr: { number: number } };
  await Promise.resolve();
  expect(lastRepos()).toMatchObject({
    repos: [{ enrolment: { state: "pending", pr: { number: pr.number } } }],
  });

  expect(err(await ask("test-signature"))).toBe("locked");
  ok(await ask("unlock", { passphrase: PASS, once: true }));
  const test = ok(await ask("test-signature")) as {
    payload: string;
    signature: string;
    verified: boolean;
  };
  expect(test.verified).toBe(true);
  expect(test.signature).toStartWith("-----BEGIN SSH SIGNATURE-----\n");
  // `once`: locked again right after the test signature
  expect(lastSigner()).toMatchObject({ signer: { state: "locked" } });
});

test("enrolment matches the key blob whatever the comment says", async () => {
  const { created, source } = await setup("team", true);
  const [type, base64] = created!.record.publicKey.split(" ");
  expect(source.enrolment(R, `${type} ${base64} someone-else@example.invalid`)).toEqual({
    state: "active",
  });
  expect(source.enrolment(R, `${type} ${base64}`)).toEqual({ state: "active" });
});

test("nod serve without --fake reads the key file before anything else", async () => {
  const keyFile = join(dir, "nod", "signing-key.json");
  const options = {
    port: 0,
    webUrl: "http://localhost:4517",
    tokenFile: join(dir, "serve-token"),
    version: null,
    keyFile,
    dir,
  };
  await createKeyFile(keyFile, PASS, { scrypt: CHEAP });
  // the key is fine: the folder is what is not a clone
  expect(() => start(options)).toThrow(/is not a git clone/);
  await writeFile(keyFile, "{}");
  expect(() => start(options)).toThrow(expect.objectContaining({ code: "bad-key-file" }));
});

test("a batch across two repos: one unlock, one signature per repo, each verifies with ssh-keygen", async () => {
  const LEDGER = "acme.ghe.com/finance/ledger";
  const { created, source, ask, at, posted, lastSigner } = await setup("repos", true);
  await source.ready;
  ok(await ask("unlock", { passphrase: PASS, once: true }));
  const result = ok(
    await ask("sign", {
      entries: [
        { repo: R, pr: 482, head_sha: at(R, 482).headSha },
        { repo: LEDGER, pr: 57, head_sha: at(LEDGER, 57).headSha },
      ],
      verdict: "approve",
    }),
  ) as { payloads: { repo: string; payload: string }[] };
  expect(lastSigner()).toMatchObject({ signer: { state: "locked" } });
  expect(posted.map((p) => p.repo)).toEqual([R, LEDGER]);
  const allowedSignersPath = join(dir, "allowed_signers");
  await writeFile(
    allowedSignersPath,
    `${allowedSignersLine("mara-l", created!.record.publicKey)}\n`,
  );
  for (const [i, input] of posted.entries()) {
    const [block] = parseNodComments(input.body);
    expect(block!.payloadLine).toBe(result.payloads[i]!.payload);
    const verified = await verifyNodBlock(block!, { allowedSignersPath });
    expect(verified.ok).toBe(true);
  }
  expect(JSON.parse(result.payloads[1]!.payload)).toMatchObject({
    repo: "finance/ledger",
    entries: [{ pr: 57 }],
  });
});

import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { tempDir } from "../../kit/test-support.ts";
import { ManualClock } from "../clock";
import { SignerError } from "../signer";
import { KeyFileSigner } from "./key-file-signer";
import { createKeyFile } from "./key-store";

const CHEAP = { N: 2 ** 10, r: 8, p: 1 };
const PASS = "correct horse battery";
const MIN = 60_000;

let dir = "";
let cleanup = async () => {};
let file = "";

beforeEach(async () => {
  ({ dir, cleanup } = await tempDir("nod-signer-"));
  file = join(dir, "nod", "signing-key.json");
});
afterEach(() => cleanup());

const code = async (p: Promise<unknown>) => {
  try {
    await p;
    return "ok";
  } catch (error) {
    return error instanceof SignerError ? error.code : `not a SignerError: ${String(error)}`;
  }
};

const signer = (clock = new ManualClock(0), wrongPassphraseDelayMs = 0) =>
  new KeyFileSigner({ clock, file, scrypt: CHEAP, wrongPassphraseDelayMs });

test("no key file: no key; createKey writes one and the signer is locked", async () => {
  const s = signer();
  expect(s.status()).toEqual({ state: "no-key" });
  expect(await code(s.unlock(PASS))).toBe("no-key");
  expect(await code(s.sign("line"))).toBe("no-key");
  let pushes = 0;
  s.subscribe(() => pushes++);
  expect(await code(s.createKey("short"))).toBe("weak-passphrase");
  expect(await code(s.createKey(PASS, "/somewhere/id_ed25519"))).toBe("not-implemented");
  expect(existsSync(file)).toBe(false);
  const key = await s.createKey(PASS);
  expect(existsSync(file)).toBe(true);
  expect(key.location).toBe(file);
  expect(key.fingerprint).toMatch(/^SHA256:[A-Za-z0-9+/]{43}$/);
  expect(s.status()).toEqual({ state: "locked", key });
  expect(pushes).toBe(1);
  expect(await code(s.createKey(PASS))).toBe("key-exists");
  // a new signer reads the same key from the file
  expect(signer().status()).toEqual({ state: "locked", key });
});

test("unlock, sign, verify with ssh-keygen; the window and its end", async () => {
  await createKeyFile(file, PASS, { scrypt: CHEAP });
  const clock = new ManualClock(1_000);
  const s = signer(clock);
  const seen: string[] = [];
  s.subscribe(() => seen.push(s.status().state));
  expect(await code(s.sign("line"))).toBe("locked");
  await s.unlock(PASS);
  expect(s.status()).toMatchObject({ state: "unlocked", until: 1_000 + 15 * MIN, once: false });
  const line = "nod test signature · mara-l · 2026-11-18T14:20:00.000Z";
  const signature = await s.sign(line);
  expect(await s.verify(line, signature)).toBe(true);
  expect(await s.verify(`${line}!`, signature)).toBe(false);
  clock.advance(15 * MIN);
  expect(s.status().state).toBe("locked");
  expect(await code(s.sign(line))).toBe("locked");
  expect(seen).toEqual(["unlocked", "locked"]);
  expect(clock.pending).toBe(0);
});

test("a window per side, one key: it is dropped when the last window closes", async () => {
  await createKeyFile(file, PASS, { scrypt: CHEAP });
  const s = signer();
  const line = "nod test signature · mara-l · 2026-11-18T14:20:00.000Z";
  await s.unlock(PASS, { side: "loopback" });
  expect(await code(s.sign(line, "named-host"))).toBe("locked");
  // Another side's unlock checks the passphrase again, and leaves the open window alone.
  expect(await code(s.unlock("not the passphrase", { side: "named-host" }))).toBe("bad-passphrase");
  expect(s.status("loopback").state).toBe("unlocked");
  await s.unlock(PASS, { side: "named-host" });
  s.lock("loopback");
  const signature = await s.sign(line, "named-host");
  expect(await s.verify(line, signature)).toBe(true);
  s.lock("named-host");
  expect(await code(s.sign(line, "named-host"))).toBe("locked");
  expect((s as unknown as { method: unknown }).method).toBeNull();
});

test("a wrong passphrase: typed, delayed, and the key stays locked", async () => {
  await createKeyFile(file, PASS, { scrypt: CHEAP });
  const s = signer(new ManualClock(0), 60);
  const started = performance.now();
  expect(await code(s.unlock("not the passphrase"))).toBe("bad-passphrase");
  expect(performance.now() - started).toBeGreaterThanOrEqual(55);
  expect(s.status().state).toBe("locked");
  try {
    await s.unlock("not the passphrase");
  } catch (error) {
    expect(`${String(error)} ${(error as Error).stack}`).not.toContain("not the passphrase");
  }
});

test("once: locks right after the next signature, and a racing second one is refused", async () => {
  await createKeyFile(file, PASS, { scrypt: CHEAP });
  const s = signer();
  await s.unlock(PASS, { once: true });
  expect(s.status()).toMatchObject({ state: "unlocked", once: true });
  const results = await Promise.all([code(s.sign("a")), code(s.sign("b"))]);
  expect(results.sort()).toEqual(["locked", "ok"]);
  expect(s.status().state).toBe("locked");
});

test("lock() drops the key now; stop() too", async () => {
  await createKeyFile(file, PASS, { scrypt: CHEAP });
  const s = signer();
  await s.unlock(PASS);
  s.lock();
  expect(await code(s.sign("line"))).toBe("locked");
  await s.unlock(PASS);
  s.stop();
  expect(await code(s.sign("line"))).toBe("locked");
});

test("a key file replaced behind nod serve's back does not unlock", async () => {
  await createKeyFile(file, PASS, { scrypt: CHEAP });
  const s = signer();
  await createKeyFile(file, PASS, { scrypt: CHEAP, replace: true });
  expect(await code(s.unlock(PASS))).toBe("bad-key-file");
  expect(s.status().state).toBe("locked");
});

test("a damaged key file fails at start", async () => {
  await createKeyFile(file, PASS, { scrypt: CHEAP });
  writeFileSync(file, "{}");
  expect(() => signer()).toThrow(SignerError);
});

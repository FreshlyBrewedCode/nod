import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { tempDir } from "../../kit/test-support.ts";
import { SignerError } from "../signer";
import { ed25519Method } from "./ed25519";
import {
  createKeyFile,
  decryptSeed,
  DEFAULT_SCRYPT,
  defaultKeyFile,
  keyOf,
  readKeyFile,
  type KeyRecord,
} from "./key-store";
import { allowedSignersLine, fingerprint, parsePublicKeyLine } from "./ssh-wire";
import { signSshsig } from "./sshsig";
import { sshKeygen } from "./test-support";

const CHEAP = { N: 2 ** 10, r: 8, p: 1 };
const PASS = "correct horse battery";

let dir = "";
let cleanup = async () => {};
let file = "";

beforeEach(async () => {
  ({ dir, cleanup } = await tempDir("nod-keystore-"));
  file = join(dir, "config", "nod", "signing-key.json");
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

const edit = (mutate: (r: Record<string, any>) => void) => {
  const r = JSON.parse(readFileSync(file, "utf8"));
  mutate(r);
  writeFileSync(file, JSON.stringify(r));
};

describe("creating a key", () => {
  test("a versioned file, 0600 in a 0700 directory, the public key in clear", async () => {
    const { record, replaced } = await createKeyFile(file, PASS, {
      scrypt: CHEAP,
      now: Date.UTC(2026, 10, 18),
    });
    expect(replaced).toBeNull();
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(join(dir, "config", "nod")).mode & 0o777).toBe(0o700);
    expect(readdirSync(join(dir, "config", "nod"))).toEqual(["signing-key.json"]);
    const stored = JSON.parse(readFileSync(file, "utf8")) as KeyRecord;
    expect(stored).toEqual(record);
    expect(stored).toMatchObject({
      nod: "signing-key",
      version: 1,
      created: "2026-11-18T00:00:00.000Z",
      kdf: { name: "scrypt", N: 1024, r: 8, p: 1 },
      cipher: { name: "aes-256-gcm" },
    });
    expect(stored.publicKey).toMatch(
      /^ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI[A-Za-z0-9+/]{43} nod$/,
    );
    expect(readKeyFile(file)).toEqual(record);
    expect(keyOf(record, file)).toEqual({
      fingerprint: fingerprint(parsePublicKeyLine(record.publicKey)),
      publicKey: record.publicKey,
      location: file,
    });
  });

  test("the plain key is nowhere in the file", async () => {
    const { record } = await createKeyFile(file, PASS, { scrypt: CHEAP });
    const seed = await decryptSeed(record, PASS);
    const text = readFileSync(file, "utf8");
    for (const encoding of ["base64", "base64url", "hex"] as const)
      expect(text).not.toContain(seed.toString(encoding));
    expect(text).not.toContain(PASS);
  });

  test("the default parameters are N = 2^17, r = 8, p = 1", () => {
    expect(DEFAULT_SCRYPT).toEqual({ N: 131072, r: 8, p: 1 });
  });

  test("passphrases: not empty, at least 12 characters, counted as characters", async () => {
    expect(await code(createKeyFile(file, "", { scrypt: CHEAP }))).toBe("weak-passphrase");
    expect(await code(createKeyFile(file, "elevenchars", { scrypt: CHEAP }))).toBe(
      "weak-passphrase",
    );
    // 12 bytes, but 3 characters
    expect(await code(createKeyFile(file, "🔑🔑🔑", { scrypt: CHEAP }))).toBe("weak-passphrase");
    expect(await code(createKeyFile(file, "x".repeat(1025), { scrypt: CHEAP }))).toBe(
      "weak-passphrase",
    );
    expect(existsSync(file)).toBe(false);
    expect(await code(createKeyFile(file, "twelve chars", { scrypt: CHEAP }))).toBe("ok");
  });

  test("an existing key is never overwritten; replace keeps the old file aside", async () => {
    const first = await createKeyFile(file, PASS, { scrypt: CHEAP });
    expect(await code(createKeyFile(file, PASS, { scrypt: CHEAP }))).toBe("key-exists");
    expect(readKeyFile(file)).toEqual(first.record);
    const second = await createKeyFile(file, PASS, {
      scrypt: CHEAP,
      replace: true,
      now: Date.UTC(2026, 10, 18, 9, 30),
    });
    expect(second.replaced).toBe(`${file}.replaced-2026-11-18T09-30-00-000Z`);
    expect(JSON.parse(readFileSync(second.replaced!, "utf8"))).toEqual(first.record);
    expect(readKeyFile(file)).toEqual(second.record);
    expect(second.record.publicKey).not.toBe(first.record.publicKey);
    // no temp files left behind
    expect(readdirSync(join(dir, "config", "nod")).sort()).toEqual(
      ["signing-key.json", "signing-key.json.replaced-2026-11-18T09-30-00-000Z"].sort(),
    );
  });

  test("defaultKeyFile honours XDG_CONFIG_HOME", () => {
    expect(defaultKeyFile({ XDG_CONFIG_HOME: "/xdg" })).toBe("/xdg/nod/signing-key.json");
  });
});

describe("opening it", () => {
  test("round trip: the decrypted seed signs as the stored public key", async () => {
    const { record } = await createKeyFile(file, PASS, { scrypt: CHEAP });
    const seed = await decryptSeed(readKeyFile(file)!, PASS);
    expect(seed).toHaveLength(32);
    const method = ed25519Method(seed);
    expect(method.publicKeyBlob).toEqual(parsePublicKeyLine(record.publicKey));
    expect(await signSshsig("line", method)).toContain("BEGIN SSH SIGNATURE");
  });

  test("a wrong passphrase is a typed error that does not echo it", async () => {
    const { record } = await createKeyFile(file, PASS, { scrypt: CHEAP });
    try {
      await decryptSeed(record, "correct horse battery!");
      throw new Error("unlocked with the wrong passphrase");
    } catch (error) {
      expect(error).toBeInstanceOf(SignerError);
      expect((error as SignerError).code).toBe("bad-passphrase");
      expect(`${String(error)} ${(error as Error).stack}`).not.toContain("correct horse");
    }
  });

  test("the passphrase is NFC-normalised: composed and decomposed é open the same key", async () => {
    const { record } = await createKeyFile(file, "café au lait s'il", { scrypt: CHEAP });
    expect(await code(decryptSeed(record, "café au lait s'il"))).toBe("ok");
  });

  test("tampering fails cleanly: ciphertext, tag, nonce, salt and parameters", async () => {
    await createKeyFile(file, PASS, { scrypt: CHEAP });
    const original = readFileSync(file, "utf8");
    const flip = (b64: string) => {
      const bytes = Buffer.from(b64, "base64");
      bytes[0]! ^= 1;
      return bytes.toString("base64");
    };
    const cases: Array<(r: Record<string, any>) => void> = [
      (r) => (r.cipher.ciphertext = flip(r.cipher.ciphertext)),
      (r) => (r.cipher.tag = flip(r.cipher.tag)),
      (r) => (r.cipher.nonce = flip(r.cipher.nonce)),
      (r) => (r.kdf.salt = flip(r.kdf.salt)),
      (r) => (r.kdf.N = 2048),
    ];
    for (const mutate of cases) {
      writeFileSync(file, original);
      edit(mutate);
      expect(await code(decryptSeed(readKeyFile(file)!, PASS))).toBe("bad-passphrase");
    }
  });

  test("a swapped public key never signs: the GCM additional data binds it", async () => {
    await createKeyFile(file, PASS, { scrypt: CHEAP });
    const other = await createKeyFile(join(dir, "other.json"), PASS, { scrypt: CHEAP });
    edit((r) => (r.publicKey = other.record.publicKey));
    expect(await code(decryptSeed(readKeyFile(file)!, PASS))).toBe("bad-passphrase");
  });

  test("a damaged or unknown file is bad-key-file; a missing one is no key", async () => {
    expect(readKeyFile(file)).toBeNull();
    await createKeyFile(file, PASS, { scrypt: CHEAP });
    const original = readFileSync(file, "utf8");
    const damaged: Array<(r: Record<string, any>) => void> = [
      (r) => (r.version = 2),
      (r) => (r.nod = "something-else"),
      (r) => (r.publicKey = "ssh-rsa AAAAB3NzaC1yc2E"),
      (r) => (r.kdf.N = 1000), // not a power of two
      (r) => (r.kdf.N = 2 ** 24), // a memory bomb
      (r) => (r.kdf.name = "pbkdf2"),
      (r) => (r.cipher.nonce = "AAAA"),
      (r) => delete r.cipher.tag,
    ];
    for (const mutate of damaged) {
      writeFileSync(file, original);
      edit(mutate);
      expect(await code((async () => readKeyFile(file))())).toBe("bad-key-file");
    }
    await writeFile(file, "{not json");
    expect(await code((async () => readKeyFile(file))())).toBe("bad-key-file");
  });
});

test("the allowed_signers line is one ssh-keygen accepts", async () => {
  const { record } = await createKeyFile(file, PASS, { scrypt: CHEAP });
  const line = allowedSignersLine("mara-l", record.publicKey);
  expect(line).toBe(`mara-l ${record.publicKey.replace(/ nod$/, "")}`);
  const allowed = join(dir, "allowed_signers");
  await writeFile(allowed, `${line}\n`);
  const method = ed25519Method(await decryptSeed(record, PASS));
  const sigPath = join(dir, "x.sig");
  await writeFile(sigPath, await signSshsig("hello", method));
  const found = await sshKeygen(["-Y", "find-principals", "-s", sigPath, "-f", allowed]);
  expect([found.status, found.stdout.trim()]).toEqual([0, "mara-l"]);
  const verified = await sshKeygen(
    ["-Y", "verify", "-f", allowed, "-I", "mara-l", "-n", "nod", "-s", sigPath],
    "hello",
  );
  expect(verified.status).toBe(0);
});

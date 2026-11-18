import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, statSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { run } from "../../kit/exec.ts";
import { tempDir } from "../../kit/test-support.ts";
import { parseKeyArgs, runKey, type KeyFlags, type KeyIo } from "./key-cli";
import { readKeyFile } from "./key-store";
import { sshKeygen } from "./test-support";

const CHEAP = { N: 2 ** 10, r: 8, p: 1 };
const PASS = "correct horse battery";

let dir = "";
let cleanup = async () => {};
let file = "";
beforeEach(async () => {
  ({ dir, cleanup } = await tempDir("nod-key-cli-"));
  file = join(dir, "nod", "signing-key.json");
});
afterEach(() => cleanup());

const flags = (argv: string[]): KeyFlags => {
  const parsed = parseKeyArgs(argv);
  if (parsed.kind !== "key") throw new Error(JSON.stringify(parsed));
  return parsed.flags;
};

function io(passphrases: string[], login: string | null = "mara-l") {
  const out: string[] = [];
  const err: string[] = [];
  const asked: { prompt: string; confirm: boolean }[] = [];
  const terminal: KeyIo = {
    out: (t) => void out.push(t),
    err: (t) => void err.push(t),
    async passphrase(prompt, options = {}) {
      asked.push({ prompt, confirm: options.confirm ?? false });
      return passphrases.shift() ?? "";
    },
    ghLogin: async () => login,
  };
  return { terminal, out, err, asked, text: () => out.join("") + err.join("") };
}

describe("parsing", () => {
  test("the three commands and their flags", () => {
    expect(flags(["create"])).toEqual({
      command: "create",
      keyFile: null,
      login: null,
      replace: false,
    });
    expect(flags(["create", "--replace", "--key-file", "/k.json"])).toMatchObject({
      replace: true,
      keyFile: "/k.json",
    });
    expect(flags(["show", "--login", "mara-l"])).toMatchObject({ login: "mara-l" });
    expect(flags(["test"]).command).toBe("test");
    expect(parseKeyArgs(["--help"])).toEqual({ kind: "help" });
  });

  test("refusals", () => {
    for (const argv of [
      [],
      ["destroy"],
      ["show", "extra"],
      ["show", "--replace"],
      ["test", "--login", "mara-l"],
      ["show", "--login", "not a login"],
      ["create", "--force"],
    ])
      expect(parseKeyArgs(argv).kind).toBe("error");
  });
});

describe("running", () => {
  test("create, show, test", async () => {
    const a = io([PASS]);
    expect(
      await runKey(flags(["create", "--key-file", file]), { io: a.terminal, scrypt: CHEAP }),
    ).toBe(0);
    expect(a.asked).toEqual([{ prompt: "New passphrase: ", confirm: true }]);
    const record = readKeyFile(file)!;
    expect(a.out.join("")).toContain(record.publicKey);
    expect(a.text()).not.toContain(PASS);

    const b = io([]);
    expect(await runKey(flags(["show", "--key-file", file]), { io: b.terminal })).toBe(0);
    expect(b.out.join("")).toBe(`mara-l ${record.publicKey.replace(/ nod$/, "")}\n`);
    const c = io([], null);
    expect(
      await runKey(flags(["show", "--key-file", file, "--login", "jonas-w"]), { io: c.terminal }),
    ).toBe(0);
    expect(c.out.join("")).toStartWith("jonas-w ssh-ed25519 ");
    const d = io([], null);
    expect(await runKey(flags(["show", "--key-file", file]), { io: d.terminal })).toBe(1);
    expect(d.err.join("")).toContain("--login");

    const e = io([PASS]);
    expect(await runKey(flags(["test", "--key-file", file]), { io: e.terminal })).toBe(0);
    expect(e.out.join("")).toContain("verified");
    expect(e.text()).not.toContain(PASS);
  });

  test("create refuses an existing key; --replace keeps it aside", async () => {
    await runKey(flags(["create", "--key-file", file]), { io: io([PASS]).terminal, scrypt: CHEAP });
    const before = readKeyFile(file)!;
    const again = io([PASS]);
    expect(
      await runKey(flags(["create", "--key-file", file]), { io: again.terminal, scrypt: CHEAP }),
    ).toBe(1);
    expect(again.asked).toEqual([]); // refused before asking
    expect(readKeyFile(file)).toEqual(before);
    const replace = io([PASS]);
    expect(
      await runKey(flags(["create", "--replace", "--key-file", file]), {
        io: replace.terminal,
        scrypt: CHEAP,
      }),
    ).toBe(0);
    expect(readKeyFile(file)!.publicKey).not.toBe(before.publicKey);
    expect(replace.err.join("")).toContain(".replaced-");
  });

  test("a short passphrase, a wrong one, no key: exit 1 and a message without the passphrase", async () => {
    const short = io(["tiny"]);
    expect(
      await runKey(flags(["create", "--key-file", file]), { io: short.terminal, scrypt: CHEAP }),
    ).toBe(1);
    expect(short.err.join("")).toContain("at least 12 characters");
    expect(existsSync(file)).toBe(false);
    const none = io([]);
    expect(await runKey(flags(["test", "--key-file", file]), { io: none.terminal })).toBe(1);
    expect(none.err.join("")).toContain("nod key create");

    await runKey(flags(["create", "--key-file", file]), { io: io([PASS]).terminal, scrypt: CHEAP });
    const wrong = io(["guessing at random"]);
    expect(await runKey(flags(["test", "--key-file", file]), { io: wrong.terminal })).toBe(1);
    expect(wrong.err.join("")).toContain("does not unlock");
    expect(wrong.text()).not.toContain("guessing at random");
  });
});

test("the real CLI: passphrase from a pipe, the key under XDG_CONFIG_HOME, a line ssh-keygen reads", async () => {
  const env = { ...process.env, XDG_CONFIG_HOME: dir };
  const cli = (args: string[], input?: string) =>
    run(process.execPath, [join(import.meta.dir, "..", "..", "cli.ts"), ...args], {
      env,
      ...(input !== undefined && { input }),
    });
  const created = await cli(["key", "create"], `${PASS}\n`);
  expect(created.status).toBe(0);
  expect(created.stdout + created.stderr).not.toContain(PASS);
  expect(statSync(file).mode & 0o777).toBe(0o600);
  expect(JSON.parse(readFileSync(file, "utf8")).kdf).toMatchObject({ N: 131072, r: 8, p: 1 });

  const shown = await cli(["key", "show", "--login", "mara-l"]);
  expect(shown.status).toBe(0);
  const allowed = join(dir, "allowed_signers");
  await writeFile(allowed, shown.stdout);
  // ssh-keygen parses the line: it finds the principal for the key
  const matched = await sshKeygen(["-Y", "match-principals", "-I", "mara-l", "-f", allowed]);
  expect([matched.status, matched.stdout.trim()]).toEqual([0, "mara-l"]);

  const tested = await cli(["key", "test"], `${PASS}\n`);
  expect([tested.status, tested.stdout]).toEqual([0, expect.stringContaining("verified")]);
  const wrong = await cli(["key", "test"], "not the passphrase\n");
  expect(wrong.status).toBe(1);
});

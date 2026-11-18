/**
 * `nod key create | show | test`: the signing key from a terminal. The
 * passphrase is read from the TTY without echo, or as the first line of
 * stdin when it is piped (scripts, tests). It is never printed.
 */

import { parseArgs as parseFlags } from "node:util";

import { run } from "../../kit/exec.ts";
import { LOGIN_RE } from "../../kit/nod.ts";
import { systemClock } from "../clock";
import { SignerError } from "../signer";
import { KeyFileSigner } from "./key-file-signer";
import { createKeyFile, defaultKeyFile, keyOf, readKeyFile, type ScryptParams } from "./key-store";
import { allowedSignersLine } from "./ssh-wire";

export type KeyCommand = "create" | "show" | "test";

export interface KeyFlags {
  readonly command: KeyCommand;
  /** Default `$XDG_CONFIG_HOME/nod/signing-key.json`. */
  readonly keyFile: string | null;
  /** `show`: the principal; default the `gh` login. */
  readonly login: string | null;
  /** `create`: move an existing key aside instead of refusing. */
  readonly replace: boolean;
}

export const KEY_HELP = `key commands:
  key create          create the signing key (asks for a passphrase)
    --replace         replace an existing key; the old file is kept aside
  key show            print the .nod/allowed_signers line for the key
    --login <login>   the GitHub login it names (default: the gh login)
  key test            unlock the key, sign a test message, verify it
  --key-file <path>   the key file (default $XDG_CONFIG_HOME/nod/signing-key.json)
`;

export function parseKeyArgs(
  args: readonly string[],
): { kind: "key"; flags: KeyFlags } | { kind: "help" } | { kind: "error"; message: string } {
  let parsed;
  try {
    parsed = parseFlags({
      args: [...args],
      strict: true,
      allowPositionals: true,
      options: {
        "key-file": { type: "string" },
        login: { type: "string" },
        replace: { type: "boolean", default: false },
        help: { type: "boolean", short: "h", default: false },
      },
    });
  } catch (error) {
    return { kind: "error", message: error instanceof Error ? error.message : String(error) };
  }
  const { values, positionals } = parsed;
  if (values.help) return { kind: "help" };
  const [command, ...extra] = positionals;
  if (command !== "create" && command !== "show" && command !== "test")
    return { kind: "error", message: "nod key needs one of: create, show, test" };
  if (extra.length) return { kind: "error", message: `unexpected argument: ${extra[0]}` };
  if (values.replace && command !== "create")
    return { kind: "error", message: "--replace goes with nod key create" };
  if (values.login !== undefined && command !== "show")
    return { kind: "error", message: "--login goes with nod key show" };
  if (values.login !== undefined && !LOGIN_RE.test(values.login))
    return { kind: "error", message: "--login is a GitHub login" };
  return {
    kind: "key",
    flags: {
      command,
      keyFile: values["key-file"] ?? null,
      login: values.login ?? null,
      replace: values.replace,
    },
  };
}

/** The terminal, injectable for tests. */
export interface KeyIo {
  out(text: string): void;
  err(text: string): void;
  /** `confirm`: ask twice on a TTY. Throws when there is no input. */
  passphrase(prompt: string, options?: { confirm?: boolean }): Promise<string>;
  /** The `gh` login, or null. */
  ghLogin(): Promise<string | null>;
}

export interface RunKeyOptions {
  readonly io?: KeyIo;
  /** Cheap parameters for tests. */
  readonly scrypt?: ScryptParams;
}

/** Runs one `nod key` command; resolves to the exit code. */
export async function runKey(flags: KeyFlags, options: RunKeyOptions = {}): Promise<number> {
  const io = options.io ?? terminalIo();
  const file = flags.keyFile ?? defaultKeyFile();
  try {
    switch (flags.command) {
      case "create":
        return await create(file, flags.replace, io, options.scrypt);
      case "show":
        return await show(file, flags.login, io);
      case "test":
        return await testKey(file, io);
    }
  } catch (error) {
    if (error instanceof SignerError) {
      io.err(`nod key ${flags.command}: ${error.message}\n`);
      return 1;
    }
    throw error;
  }
}

async function create(
  file: string,
  replace: boolean,
  io: KeyIo,
  scrypt: ScryptParams | undefined,
): Promise<number> {
  if (!replace && readKeyFile(file)) {
    io.err(
      `nod key create: there is a signing key already (${file}).\n` +
        "  Use --replace to make a new one; the old file is kept aside, and the new key\n" +
        "  needs enrolling again (a PR to .nod/allowed_signers).\n",
    );
    return 1;
  }
  const passphrase = await io.passphrase("New passphrase: ", { confirm: true });
  const { record, replaced } = await createKeyFile(file, passphrase, {
    replace,
    ...(scrypt && { scrypt }),
  });
  const key = keyOf(record, file);
  if (replaced) io.err(`The old key file was moved to ${replaced}\n`);
  io.out(
    `Created the signing key ${key.fingerprint}\n  ${key.publicKey}\n  in ${file}\n` +
      "Next: `nod key show` prints its line for .nod/allowed_signers.\n",
  );
  return 0;
}

async function show(file: string, login: string | null, io: KeyIo): Promise<number> {
  const record = readKeyFile(file);
  if (!record) {
    io.err("nod key show: there is no signing key yet. Run `nod key create`.\n");
    return 1;
  }
  const principal = login ?? (await io.ghLogin());
  if (!principal) {
    io.err("nod key show: `gh` is not logged in; pass --login <your GitHub login>.\n");
    return 1;
  }
  io.out(`${allowedSignersLine(principal, record.publicKey)}\n`);
  io.err(`(${keyOf(record, file).fingerprint}: add the line above to .nod/allowed_signers)\n`);
  return 0;
}

async function testKey(file: string, io: KeyIo): Promise<number> {
  const signer = new KeyFileSigner({ clock: systemClock, file });
  try {
    const status = signer.status();
    if (status.state === "no-key") {
      io.err("nod key test: there is no signing key yet. Run `nod key create`.\n");
      return 1;
    }
    await signer.unlock(await io.passphrase("Passphrase: "), { minutes: 1, once: true });
    const line = `nod test signature · ${status.key.fingerprint} · ${new Date().toISOString()}`;
    const signature = await signer.sign(line);
    if (!(await signer.verify(line, signature))) {
      io.err("nod key test: the signature did not verify with ssh-keygen.\n");
      return 1;
    }
    io.out(`verified: ssh-keygen accepts a signature by ${status.key.fingerprint}\n`);
    return 0;
  } finally {
    signer.stop();
  }
}

// ---------------------------------------------------------------------------
// the real terminal

function terminalIo(): KeyIo {
  let piped: Promise<string> | null = null;
  return {
    out: (text) => void process.stdout.write(text),
    err: (text) => void process.stderr.write(text),
    async passphrase(prompt, options = {}) {
      if (!process.stdin.isTTY) {
        // Piped: the first line, once; no confirmation to ask for.
        piped ??= Bun.stdin.text().then((text) => text.split(/\r?\n/)[0] ?? "");
        return piped;
      }
      const first = await readHidden(prompt);
      if (!options.confirm) return first;
      if ((await readHidden("Again: ")) !== first)
        throw new SignerError("weak-passphrase", "The two passphrases differ.");
      return first;
    },
    async ghLogin() {
      try {
        const r = await run("gh", ["api", "user", "--jq", ".login"], { timeoutMs: 20_000 });
        const login = r.stdout.trim();
        return r.status === 0 && LOGIN_RE.test(login) ? login : null;
      } catch {
        return null;
      }
    },
  };
}

/** One line from the TTY in raw mode, so nothing is echoed. Ctrl-C quits. */
function readHidden(prompt: string): Promise<string> {
  const stdin = process.stdin;
  process.stderr.write(prompt);
  stdin.setRawMode(true);
  stdin.resume();
  return new Promise((resolve) => {
    let value = "";
    const done = () => {
      stdin.off("data", onData);
      stdin.setRawMode(false);
      stdin.pause();
      process.stderr.write("\n");
    };
    const onData = (chunk: Buffer) => {
      for (const ch of chunk.toString("utf8")) {
        if (ch === "\r" || ch === "\n" || ch === "\u0004") {
          done();
          resolve(value);
          return;
        }
        if (ch === "\u0003") {
          done();
          process.exit(130);
        }
        if (ch === "\u007f" || ch === "\b") value = [...value].slice(0, -1).join("");
        else if (ch >= " ") value += ch;
      }
    };
    stdin.on("data", onData);
  });
}

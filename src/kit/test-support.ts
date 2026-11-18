/**
 * Test helpers: throwaway temp dirs, git repos and ed25519 keys. Never
 * touches `~/.ssh` or the global git config. Not part of the kit's API.
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import type { ClassifierContext, PullRequestInfo } from "./classifiers/types.ts";
import { run } from "./exec.ts";
import { git, type ChangedFile } from "./patch-id.ts";

/** A fresh temp dir and a function that removes it. */
export async function tempDir(
  prefix = "nod-test-",
): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

const sshEnv = () => {
  const env = { ...process.env };
  delete env.SSH_AUTH_SOCK;
  return env;
};

/** Creates an unencrypted throwaway ed25519 key in `dir`. */
export async function makeKey(
  dir: string,
  name: string,
): Promise<{ privateKey: string; publicKey: string }> {
  const privateKey = join(dir, `${name}_ed25519`);
  const r = await run(
    "ssh-keygen",
    ["-q", "-t", "ed25519", "-N", "", "-C", `${name}@example.invalid`, "-f", privateKey],
    {
      env: sshEnv(),
    },
  );
  if (r.status !== 0) throw new Error(r.stderr);
  return { privateKey, publicKey: (await readFile(`${privateKey}.pub`, "utf8")).trim() };
}

/** Signs `message` with `ssh-keygen -Y sign` and returns the armored signature. */
export async function sshSign(
  privateKey: string,
  message: string,
  namespace = "nod",
): Promise<string> {
  const { dir, cleanup } = await tempDir("nod-sign-");
  try {
    const file = join(dir, "msg");
    await writeFile(file, message);
    const r = await run(
      "ssh-keygen",
      ["-Y", "sign", "-q", "-f", privateKey, "-n", namespace, file],
      { env: sshEnv() },
    );
    if (r.status !== 0) throw new Error(r.stderr);
    return await readFile(`${file}.sig`, "utf8");
  } finally {
    await cleanup();
  }
}

/** A git repo in a temp dir with a local identity, plus helpers to commit. */
export async function tempRepo(): Promise<{
  dir: string;
  cleanup: () => Promise<void>;
  git: (...args: string[]) => Promise<string>;
  write: (path: string, content: string | Uint8Array) => Promise<void>;
  commit: (message: string) => Promise<string>;
}> {
  const { dir, cleanup } = await tempDir("nod-repo-");
  const g = (...args: string[]) => git(dir, args);
  await g("init", "-q", "-b", "main");
  await g("config", "user.name", "alice");
  await g("config", "user.email", "alice@example.invalid");
  await g("config", "commit.gpgsign", "false");
  const write = async (path: string, content: string | Uint8Array) => {
    const full = join(dir, path);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, content);
  };
  const commit = async (message: string) => {
    await g("add", "-A");
    await g("commit", "-q", "--allow-empty", "-m", message);
    return (await g("rev-parse", "HEAD")).trim();
  };
  return { dir, cleanup, git: g, write, commit };
}

/** A changed file for classifier tests. */
export const file = (path: string, added = 1, removed = 0, binary = false): ChangedFile => ({
  path,
  status: "modified",
  added,
  removed,
  binary,
});

/** A classifier context for alice's PR #12; `baseFiles` is what `readBaseFile` sees. */
export const context = (
  files: ChangedFile[],
  pr: Partial<PullRequestInfo> = {},
  baseFiles: Record<string, string> = {},
): ClassifierContext => ({
  pr: {
    repo: "acme/widgets",
    number: 12,
    title: "Add a thing",
    body: "",
    author: "alice",
    labels: [],
    base: "main",
    head_sha: "a".repeat(40),
    ...pr,
  },
  files,
  readBaseFile: async (path) => baseFiles[path] ?? null,
});

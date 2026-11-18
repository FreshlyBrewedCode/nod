/**
 * Spawning helper for the two programs the kit relies on, `git` and
 * `ssh-keygen`. Always an argument array, never a shell, so nothing from a
 * comment, a title or a branch name is ever interpreted.
 */
import { spawn } from "node:child_process";

/** What a finished process left behind. */
export interface RunResult {
  /** Exit code, or `null` when the process was killed (e.g. by the timeout). */
  status: number | null;
  stdout: string;
  stderr: string;
}

/** Options for {@link run}. */
export interface RunOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** Bytes written to stdin, then stdin is closed. Without it stdin is empty. */
  input?: string | Uint8Array;
  /** Kill the process after this many milliseconds (default 60 s). */
  timeoutMs?: number;
  /** Fail when stdout grows beyond this many bytes (default 256 MiB). */
  maxStdoutBytes?: number;
}

/**
 * Runs `command` with `args` and collects its output. Resolves for any exit
 * code; rejects only when the program cannot be started or its output is too
 * large.
 */
export function run(
  command: string,
  args: readonly string[],
  options: RunOptions = {},
): Promise<RunResult> {
  const { cwd, env, input, timeoutMs = 60_000, maxStdoutBytes = 256 * 1024 * 1024 } = options;
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: ["pipe", "pipe", "pipe"], shell: false });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let outBytes = 0;
    let failed = false;
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    const fail = (e: Error) => {
      if (failed) return;
      failed = true;
      clearTimeout(timer);
      child.kill("SIGKILL");
      reject(e);
    };
    child.on("error", fail);
    child.stdout.on("data", (chunk: Buffer) => {
      outBytes += chunk.length;
      if (outBytes > maxStdoutBytes)
        fail(new Error(`${command}: output exceeds ${maxStdoutBytes} bytes`));
      else out.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (err.length < 1024) err.push(chunk);
    });
    child.on("close", (status) => {
      clearTimeout(timer);
      if (failed) return;
      resolve({
        status,
        stdout: Buffer.concat(out).toString("utf8"),
        stderr: Buffer.concat(err).toString("utf8"),
      });
    });
    // A child that exits before reading stdin makes the write fail with EPIPE; the exit code tells the story.
    child.stdin.on("error", () => {});
    child.stdin.end(input ?? "");
  });
}

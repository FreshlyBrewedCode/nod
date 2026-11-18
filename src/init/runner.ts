/**
 * How `nod init` runs `git`, `gh` and `bun`: an injectable runner, so tests
 * can fake GitHub and the install while keeping real git. Always an argument
 * array, never a shell.
 */

export interface RunResult {
  status: number;
  stdout: string;
  stderr: string;
}

export interface Runner {
  run(cmd: readonly string[], options?: { cwd?: string; input?: string }): Promise<RunResult>;
}

/** The real runner: `Bun.spawn`. The user's own `gh` credentials, no new scopes. */
export const processRunner: Runner = {
  async run(cmd, options = {}) {
    const proc = Bun.spawn([...cmd], {
      cwd: options.cwd,
      stdin: options.input === undefined ? "ignore" : new TextEncoder().encode(options.input),
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, status] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { status, stdout, stderr };
  },
};

/** Runs a command and returns its trimmed stdout, or throws with its stderr. */
export async function must(
  runner: Runner,
  cmd: readonly string[],
  options?: { cwd?: string; input?: string },
): Promise<string> {
  const r = await runner.run(cmd, options);
  if (r.status !== 0) {
    const why = (r.stderr.trim() || r.stdout.trim()).split("\n").slice(-3).join(" ");
    throw new Error(`\`${cmd.slice(0, 3).join(" ")}\` failed: ${why}`);
  }
  return r.stdout.trim();
}

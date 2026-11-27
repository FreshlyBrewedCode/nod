/**
 * Every process the service code starts (`systemctl`, `launchctl`) goes
 * through a `ProcessRunner`, so tests and `--fake` never touch the real
 * ones: they pass a {@link FakeRunner} (`fake.ts`). The real runner is the
 * kit's `run` (an argument array, never a shell).
 */

import { run, type RunResult } from "../kit/exec.ts";

export type { RunResult };

/** Runs `command` with `args`. Resolves for any exit code; rejects when the program cannot start. */
export type ProcessRunner = (command: string, args: readonly string[]) => Promise<RunResult>;

/** The real runner. Only `createServiceManager` ever defaults to it. */
export const systemRunner: ProcessRunner = (command, args) =>
  run(command, args, { timeoutMs: 30_000 });

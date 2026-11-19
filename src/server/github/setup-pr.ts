/**
 * Onboarding's "open the setup PR": `nod init` (src/init), run in a
 * temporary worktree of the user's clone, so the user's working tree and
 * current branch stay as they are. The first signer is the user's key.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { setupRepo } from "../../init/init.ts";
import { processRunner, type Runner } from "../../init/runner.ts";

export interface SetupPrInput {
  /** The clone's root. */
  readonly dir: string;
  readonly repo: string;
  /** The GitHub host of the repo: every `gh` call `nod init` makes names it. */
  readonly host: string;
  readonly login: string;
  /** `ssh-ed25519 AAAA…`: the first allowed signer. */
  readonly publicKey: string;
  /** The running CLI's version (pins the kit). */
  readonly version: string;
  readonly runner?: Runner;
  readonly log?: (line: string) => void;
}

/** Opens the setup PR and resolves to its URL. Throws with `nod init`'s sentence. */
export async function openSetupPrWithInit(input: SetupPrInput): Promise<string> {
  const runner = input.runner ?? processRunner;
  const parent = await mkdtemp(join(tmpdir(), "nod-setup-"));
  const tree = join(parent, "tree");
  const git = async (args: string[]) => {
    const r = await runner.run(["git", "-C", input.dir, ...args]);
    if (r.status !== 0) throw new Error(`git ${args[0]} failed: ${r.stderr.trim().slice(0, 300)}`);
  };
  try {
    await git(["worktree", "add", "--quiet", "--detach", tree, "HEAD"]);
    const url = await setupRepo(
      {
        repo: input.repo,
        host: input.host,
        dir: tree,
        signers: [`${input.login} ${input.publicKey}`],
        signerKeys: [],
        kit: null,
        dryRun: false,
        pr: true,
        force: false,
        ruleset: false,
      },
      { version: input.version, runner, cwd: tree },
      (line) => input.log?.(line),
    );
    if (!url) throw new Error("nod init did not open a pull request");
    return url;
  } finally {
    await runner.run(["git", "-C", input.dir, "worktree", "remove", "--force", tree]);
    await runner.run(["git", "-C", input.dir, "worktree", "prune"]);
    await rm(parent, { recursive: true, force: true });
  }
}

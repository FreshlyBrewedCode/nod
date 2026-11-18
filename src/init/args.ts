/** `nod init` flags. */
import { parseArgs } from "node:util";

export interface InitFlags {
  /** `owner/name`; default: the repo of `dir`. */
  readonly repo: string | null;
  /** The local clone; default: the current folder. */
  readonly dir: string | null;
  /** `--signer "<login> <ssh-ed25519 …>"`, repeatable. */
  readonly signers: readonly string[];
  /** `--signer-key <file.pub>`, repeatable; the login is the `gh` user's. */
  readonly signerKeys: readonly string[];
  /** The kit dependency for `.nod/package.json`; default: this CLI's version or commit. */
  readonly kit: string | null;
  readonly dryRun: boolean;
  /** `false` with `--no-pr`: commit on the branch, but neither push nor open the PR. */
  readonly pr: boolean;
  readonly force: boolean;
  /** Apply the ruleset and auto-merge instead (after the setup PR merged). */
  readonly ruleset: boolean;
}

export const INIT_HELP = `init options:
  --signer "<login> <key>"  the first signer(s): GitHub login and ssh-ed25519
                      public key (repeatable)
  --signer-key <file> a public key file; the login is your gh user's
  --repo <owner/name> the repository (default: the one of --dir)
  --dir <path>        the local clone (default: this folder)
  --kit <spec>        the kit dependency (default: this nod's version, or
                      github:FreshlyBrewedCode/nod#<commit> for a checkout)
  --dry-run           write the files here, change nothing else
  --no-pr             commit on nod/setup, do not push or open the PR
  --force             replace an existing .nod/ (or with --ruleset: apply it
                      before the verifier is on the default branch)
  --ruleset           after the setup PR merged: require nod on the default
                      branch and enable auto-merge (needs admin rights)`;

/** Parses the arguments after `init`. */
export function parseInitArgs(
  args: readonly string[],
): { kind: "init"; flags: InitFlags } | { kind: "help" } | { kind: "error"; message: string } {
  let values;
  try {
    ({ values } = parseArgs({
      args: [...args],
      strict: true,
      allowPositionals: false,
      allowNegative: true,
      options: {
        repo: { type: "string" },
        dir: { type: "string" },
        signer: { type: "string", multiple: true },
        "signer-key": { type: "string", multiple: true },
        kit: { type: "string" },
        "dry-run": { type: "boolean", default: false },
        pr: { type: "boolean", default: true },
        force: { type: "boolean", default: false },
        ruleset: { type: "boolean", default: false },
        help: { type: "boolean", short: "h", default: false },
      },
    }));
  } catch (error) {
    return { kind: "error", message: error instanceof Error ? error.message : String(error) };
  }
  if (values.help) return { kind: "help" };
  if (values.repo !== undefined && !/^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/.test(values.repo))
    return { kind: "error", message: "--repo is owner/name" };
  if (values.kit !== undefined && (!values.kit || /\s|"/.test(values.kit)))
    return {
      kind: "error",
      message: "--kit is a package spec, e.g. ^1.2.0 or github:owner/repo#sha",
    };
  return {
    kind: "init",
    flags: {
      repo: values.repo ?? null,
      dir: values.dir ?? null,
      signers: values.signer ?? [],
      signerKeys: values["signer-key"] ?? [],
      kit: values.kit ?? null,
      dryRun: values["dry-run"],
      pr: values.pr,
      force: values.force,
      ruleset: values.ruleset,
    },
  };
}

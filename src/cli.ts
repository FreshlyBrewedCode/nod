/**
 * The `nod` CLI entry: `nod serve` (the local server, src/server/) and
 * `nod init` (opens the repo-owned setup PR). Only argument parsing exists so far.
 */
// Placeholder: the release task (semantic-release) stamps the real version.
const VERSION = "0.0.0-development";

export type Command =
  | { kind: "serve" }
  | { kind: "init" }
  | { kind: "help" }
  | { kind: "version" }
  | { kind: "error"; message: string };

export const HELP = `nod ${VERSION}

usage: nod <command>

commands:
  serve        start the local server for the dashboard
  init         set up .nod/ and the workflow in this repository

options:
  --help       show this help
  --version    show the version
`;

export function parseArgs(argv: readonly string[]): Command {
  const [first, ...rest] = argv;
  if (first === undefined || first === "--help" || first === "-h" || first === "help")
    return { kind: "help" };
  if (first === "--version" || first === "-v") return { kind: "version" };
  if (first === "serve" || first === "init") {
    return rest.length === 0
      ? { kind: first }
      : { kind: "error", message: `unexpected argument: ${rest[0]}` };
  }
  return { kind: "error", message: `unknown command: ${first}` };
}

function main(argv: readonly string[]): number {
  const cmd = parseArgs(argv);
  switch (cmd.kind) {
    case "help":
      console.log(HELP);
      return 0;
    case "version":
      console.log(VERSION);
      return 0;
    case "serve":
    case "init":
      console.error(`nod ${cmd.kind}: not implemented yet`);
      return 1;
    case "error":
      console.error(`${cmd.message}\n\n${HELP}`);
      return 2;
  }
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));

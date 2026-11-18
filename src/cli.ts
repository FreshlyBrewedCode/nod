/**
 * The `nod` CLI entry: `nod serve` (the local server, src/server/),
 * `nod key` (the signing key, src/server/signer/key-cli.ts) and `nod init`
 * (opens the repo-owned setup PR, src/init/).
 */
import { parseArgs as parseFlags } from "node:util";

import { INIT_HELP, parseInitArgs, type InitFlags } from "./init/args";

import { FAKE_SCENARIOS, type FakeScenario } from "./server/fake-source";
import { KEY_HELP, parseKeyArgs, type KeyFlags } from "./server/signer/key-cli";
import { DEFAULT_SERVE_PORT } from "./shared/protocol";

// Placeholder: the release task (semantic-release) stamps the real version.
const VERSION = "0.0.0-development";

const SCENARIOS = FAKE_SCENARIOS;
type Scenario = FakeScenario;

export interface ServeFlags {
  readonly fake: boolean;
  readonly scenario: Scenario;
  /** With `--fake`: nothing happens on its own (no checks finishing, no merges). */
  readonly frozen: boolean;
  readonly port: number;
  readonly repo: string | null;
  readonly webUrl: string | null;
  readonly tokenFile: string | null;
  readonly newToken: boolean;
  readonly open: boolean;
}

export type Command =
  | { kind: "serve"; flags: ServeFlags }
  | { kind: "init"; flags: InitFlags }
  | { kind: "key"; flags: KeyFlags }
  | { kind: "help" }
  | { kind: "version" }
  | { kind: "error"; message: string };

export const HELP = `nod ${VERSION}

usage: nod <command>

commands:
  serve        start the local server for the dashboard
  init         set up .nod/ and the workflow in this repository
  key          create, show or test the signing key (see below)

serve options:
  --port <n>          port on 127.0.0.1 (default ${DEFAULT_SERVE_PORT})
  --repo <owner/name> the repository (default: the one of this folder)
  --web-url <url>     the web app to pair with (default: this release's, or
                      the Vite dev server for a checkout; env NOD_WEB_URL)
  --fake              serve a fake team and repo instead of GitHub
  --scenario <name>   with --fake: ${SCENARIOS.join(", ")} (default team)
  --frozen            with --fake: nothing changes on its own
  --token-file <path> where the pairing token is kept
                      (default $XDG_CONFIG_HOME/nod/serve-token)
  --new-token         replace the token: every paired browser pairs again
  --open              open the host link in a browser
  --no-open           do not (the default)

${INIT_HELP}

${KEY_HELP}

options:
  --help       show this help
  --version    show the version
`;

export function parseArgs(argv: readonly string[]): Command {
  const [first, ...rest] = argv;
  if (first === undefined || first === "--help" || first === "-h" || first === "help")
    return { kind: "help" };
  if (first === "--version" || first === "-v") return { kind: "version" };
  if (first === "init") return parseInitArgs(rest);
  if (first === "serve") return parseServe(rest);
  if (first === "key") return parseKeyArgs(rest);
  return { kind: "error", message: `unknown command: ${first}` };
}

function parseServe(args: string[]): Command {
  let values;
  try {
    ({ values } = parseFlags({
      args,
      strict: true,
      allowPositionals: false,
      allowNegative: true,
      options: {
        fake: { type: "boolean", default: false },
        scenario: { type: "string" },
        frozen: { type: "boolean", default: false },
        port: { type: "string" },
        repo: { type: "string" },
        "web-url": { type: "string" },
        "token-file": { type: "string" },
        "new-token": { type: "boolean", default: false },
        open: { type: "boolean", default: false },
        help: { type: "boolean", short: "h", default: false },
      },
    }));
  } catch (error) {
    return { kind: "error", message: error instanceof Error ? error.message : String(error) };
  }
  if (values.help) return { kind: "help" };
  const port = values.port === undefined ? DEFAULT_SERVE_PORT : Number(values.port);
  if (!Number.isInteger(port) || port < 0 || port > 65535)
    return { kind: "error", message: `--port must be a port number, not ${values.port}` };
  const scenario = values.scenario ?? "team";
  if (!(SCENARIOS as readonly string[]).includes(scenario))
    return { kind: "error", message: `--scenario is one of ${SCENARIOS.join(", ")}` };
  if (values.scenario !== undefined && !values.fake)
    return { kind: "error", message: "--scenario needs --fake" };
  if (values.repo !== undefined && !/^[\w.-]+\/[\w.-]+$/.test(values.repo))
    return { kind: "error", message: "--repo is owner/name" };
  const webUrl = values["web-url"] ?? null;
  if (webUrl !== null && !/^https?:\/\/[^/]+/.test(webUrl))
    return { kind: "error", message: "--web-url is an http(s) URL" };
  return {
    kind: "serve",
    flags: {
      fake: values.fake,
      scenario: scenario as Scenario,
      frozen: values.frozen,
      port,
      repo: values.repo ?? null,
      webUrl,
      tokenFile: values["token-file"] ?? null,
      newToken: values["new-token"],
      open: values.open,
    },
  };
}

async function runServe(flags: ServeFlags): Promise<number> {
  const { start } = await import("./server/start");
  const { defaultWebUrl } = await import("./server/web-url");
  const { defaultTokenFile } = await import("./server/token");
  const webUrl = flags.webUrl ?? process.env.NOD_WEB_URL ?? defaultWebUrl(VERSION);
  let started;
  try {
    started = start({
      port: flags.port,
      webUrl,
      tokenFile: flags.tokenFile ?? defaultTokenFile(),
      newToken: flags.newToken,
      version: VERSION,
      fake: flags.fake ? { scenario: flags.scenario, live: !flags.frozen } : null,
      repo: flags.repo,
    });
  } catch (error) {
    const code = (error as { code?: string }).code;
    console.error(
      code === "EADDRINUSE"
        ? `nod serve: port ${flags.port} is in use. Is nod serve running already? Try --port.`
        : `nod serve: ${error instanceof Error ? error.message : String(error)}`,
    );
    return 1;
  }

  const what = flags.fake ? `fake data (scenario ${flags.scenario})` : "GitHub";
  console.log(
    `nod serve on ${started.wsUrl} · ${what} · ${started.source.repo() ?? "no repo yet"}`,
  );
  console.log(`\n  open the dashboard:\n  ${started.link}\n`);
  console.log("  keep this link to yourself: while signing is unlocked, it can sign.\n");
  if (flags.open) openBrowser(started.link);

  const stop = () => {
    void started.stop().then(() => process.exit(0));
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  return new Promise<number>(() => {});
}

function openBrowser(url: string) {
  const command =
    process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  try {
    Bun.spawn([command, url], { stdout: "ignore", stderr: "ignore" });
  } catch {
    console.error(`  could not run ${command}; open the link by hand.`);
  }
}

async function main(argv: readonly string[]): Promise<number> {
  const cmd = parseArgs(argv);
  switch (cmd.kind) {
    case "help":
      console.log(HELP);
      return 0;
    case "version":
      console.log(VERSION);
      return 0;
    case "serve":
      return runServe(cmd.flags);
    case "key":
      return (await import("./server/signer/key-cli")).runKey(cmd.flags);
    case "init": {
      const { runInit } = await import("./init/init");
      return runInit(cmd.flags, { version: VERSION });
    }
    case "error":
      console.error(`${cmd.message}\n\n${HELP}`);
      return 2;
  }
}

// Run directly (`bun src/cli.ts`), or through the published launcher, which
// imports this module, so `import.meta.main` is false there.
if (import.meta.main || /[\\/]bin[\\/]nod\.js$/.test(Bun.main))
  process.exit(await main(process.argv.slice(2)));

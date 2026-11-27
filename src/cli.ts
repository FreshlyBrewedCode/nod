/**
 * The `nod` CLI entry: `nod serve` (the local server, src/server/),
 * `nod repo` (the repo list, src/server/repo-cli.ts), `nod key` (the
 * signing key, src/server/signer/key-cli.ts), `nod service` (serve in the
 * background, src/service/), `nod init` (opens the repo-owned setup PR,
 * src/init/) and `nod inbox` (my own inbox, src/server/inbox/cli.ts).
 */
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs as parseFlags } from "node:util";

import { INIT_HELP, parseInitArgs, type InitFlags } from "./init/args";
import { githubHost } from "./kit/host.ts";
import { parseServiceArgs, SERVICE_HELP, type ServiceFlags } from "./service/cli";

import {
  FAKE_INSTALLS,
  FAKE_SERVICES,
  FAKE_UPDATES,
  type FakeInstall,
  type FakeService,
  type FakeUpdate,
} from "./server/fake-app";
import { FAKE_SCENARIOS, type FakeScenario } from "./server/fake-source";
import { parseNamedHost, type NamedHost } from "./shared/named-host";
import { KEY_HELP, parseKeyArgs, type KeyFlags } from "./server/signer/key-cli";
import { REPO_HELP, parseRepoArgs, type RepoFlags } from "./server/repo-cli";
import { INBOX_HELP, parseInboxArgs, type InboxFlags } from "./server/inbox/cli";
import { DEFAULT_SERVE_PORT } from "./shared/protocol";
import type { AppSeams } from "./server/app-control";
import { defaultConfigFile, readConfig } from "./server/config";
import { createServiceManager } from "./service/manager";
import { hostsToCheck, servicePreflight } from "./service/preflight";
import { GitHubReleaseFeed, createInstaller, jsonFileChannelStore } from "./server/update";

// Placeholder: the release task (semantic-release) stamps the real version.
const VERSION = "0.0.0-development";

const SCENARIOS = FAKE_SCENARIOS;
type Scenario = FakeScenario;

export interface ServeFlags {
  readonly fake: boolean;
  readonly scenario: Scenario;
  /** With `--fake`: nothing happens on its own (no checks finishing, no merges). */
  readonly frozen: boolean;
  /** With `--fake`: the update check's state (default `available`). */
  readonly fakeUpdate: FakeUpdate;
  /** With `--fake`: the background service's state (default `not-installed`). */
  readonly fakeService: FakeService;
  /** With `--fake`: how nod was installed, or `fail` (default `npm`). */
  readonly fakeInstall: FakeInstall;
  /** The flags as given, for the service set up from the page (`serviceArgsOf`). */
  readonly args: ReadonlyArray<string>;
  readonly port: number;
  readonly repo: string | null;
  /** The GitHub host (default: the clone's origin's). */
  readonly host: string | null;
  /** The clone to read (default: the current folder). */
  readonly dir: string | null;
  /** Seconds between two reads of GitHub (default 60). */
  readonly poll: number | null;
  readonly webUrl: string | null;
  readonly tokenFile: string | null;
  /** Renew both tokens. */
  readonly newToken: boolean;
  /** Renew only the remote token, the named host's. */
  readonly newRemoteToken: boolean;
  readonly open: boolean;
  /** `--allow-host`: the TLS proxy's name in front of the port (another device, ADR 0005). */
  readonly allowHost: NamedHost | null;
  /** `--web-dir`: the built web app it serves, on loopback (the app) and on that name. */
  readonly webDir: string | null;
  /** `--inbox`: my own inbox's folder (default `$XDG_CONFIG_HOME/nod/inbox`). */
  readonly inbox: string | null;
}

export type Command =
  | { kind: "serve"; flags: ServeFlags }
  | { kind: "init"; flags: InitFlags }
  | { kind: "key"; flags: KeyFlags }
  | { kind: "repo"; flags: RepoFlags }
  | { kind: "service"; flags: ServiceFlags }
  | { kind: "inbox"; flags: InboxFlags }
  | { kind: "help" }
  | { kind: "version" }
  | { kind: "error"; message: string };

export const HELP = `nod ${VERSION}

usage: nod <command>

commands:
  serve        start the local server for the dashboard
  repo         add, remove or list the repositories nod serve reads
  init         set up .nod/ and the workflow in this repository
  key          create, show or test the signing key (see below)
  service      run nod serve in the background (see below)
  inbox        your own inbox: write it, test it on a pull request

nod serve reads every repository of its list (nod repo, below), each from
nod's own clone. With an empty list, started in a clone, it reads that
clone's repository, as --dir does.

serve options:
  --port <n>          port on 127.0.0.1 (default ${DEFAULT_SERVE_PORT})
  --dir <path>        serve this one clone instead of the list (default,
                      with an empty list: this folder, when it is a clone);
                      nod fetches PR objects into it (refs/nod/*) to compute
                      patch-ids, and never checks anything out
  --repo <owner/name> with a clone: the repository (default: its origin)
  --host <host>       with a clone: its GitHub host, github.com,
                      <name>.ghe.com or a GitHub Enterprise Server (default:
                      the host of its origin; needed when origin names an
                      ssh alias)
  --poll <seconds>    how often to read GitHub (default 60, at least 10)
  --web-url <url>     the web app the printed link opens instead of the app
                      nod serves on 127.0.0.1 (a checkout: default the Vite
                      dev server; env NOD_WEB_URL); its origin may pair
  --fake              serve a fake team and repo instead of GitHub
  --scenario <name>   with --fake: ${SCENARIOS.join(", ")} (default team)
  --frozen            with --fake: nothing changes on its own
  --fake-update <state>
                      with --fake: ${FAKE_UPDATES.join(", ")} (default
                      available: 0.3.0 is on offer to a fake 0.2.0)
  --fake-service <state>
                      with --fake: ${FAKE_SERVICES.join(", ")}
                      (default not-installed)
  --fake-install <how>
                      with --fake: ${FAKE_INSTALLS.join(", ")} (default npm;
                      unknown: nod shows the commands only; fail: the
                      install fails)
  --inbox <path>      your own inbox's folder (default
                      $XDG_CONFIG_HOME/nod/inbox; with --fake: the
                      scenario's, the built-in defaults but for insights)
  --token-file <path> where the pairing token is kept
                      (default $XDG_CONFIG_HOME/nod/serve-token); the
                      remote token is next to it, as <path>-remote
  --new-token         replace both tokens: every paired browser pairs again
  --new-remote-token  replace only the remote token: the other device pairs
                      again, this machine's browser stays paired
  --allow-host <name[:port]>
                      also answer to this https name, the one a TLS proxy
                      such as tailscale serve gives the port, and serve the
                      web app there for another device; prints its link
                      and a QR code
  --web-dir <path>    the built web app nod serves on http://127.0.0.1:<port>/
                      and on --allow-host's name (default: the one this nod
                      ships, in a checkout dist/web once built)
  --open              open the host link in a browser
  --no-open           do not (the default)

${REPO_HELP}
${INIT_HELP}

${KEY_HELP}
${SERVICE_HELP}
${INBOX_HELP}
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
  if (first === "repo") return parseRepoArgs(rest);
  if (first === "service") return parseServiceArgs(rest, parseServe);
  if (first === "inbox") return parseInboxArgs(rest);
  return { kind: "error", message: `unknown command: ${first}` };
}

function parseServe(args: string[]): Extract<Command, { kind: "serve" | "help" | "error" }> {
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
        "fake-update": { type: "string" },
        "fake-service": { type: "string" },
        "fake-install": { type: "string" },
        port: { type: "string" },
        repo: { type: "string" },
        host: { type: "string" },
        dir: { type: "string" },
        poll: { type: "string" },
        "web-url": { type: "string" },
        "token-file": { type: "string" },
        "new-token": { type: "boolean", default: false },
        "new-remote-token": { type: "boolean", default: false },
        open: { type: "boolean", default: false },
        "allow-host": { type: "string" },
        "web-dir": { type: "string" },
        inbox: { type: "string" },
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
  const fakeUpdate = values["fake-update"] ?? "available";
  const fakeService = values["fake-service"] ?? "not-installed";
  const fakeInstall = values["fake-install"] ?? "npm";
  for (const [flag, value, allowed] of [
    ["--fake-update", fakeUpdate, FAKE_UPDATES],
    ["--fake-service", fakeService, FAKE_SERVICES],
    ["--fake-install", fakeInstall, FAKE_INSTALLS],
  ] as const) {
    if (!(allowed as readonly string[]).includes(value))
      return { kind: "error", message: `${flag} is one of ${allowed.join(", ")}` };
    if (values[flag.slice(2) as "fake-update"] !== undefined && !values.fake)
      return { kind: "error", message: `${flag} needs --fake` };
  }
  if (values.repo !== undefined && !/^[\w.-]+\/[\w.-]+$/.test(values.repo))
    return { kind: "error", message: "--repo is owner/name" };
  const poll = values.poll === undefined ? null : Number(values.poll);
  if (poll !== null && (!Number.isFinite(poll) || poll < 10 || poll > 3600))
    return { kind: "error", message: "--poll is a number of seconds from 10 to 3600" };
  if (values.fake && (values.dir !== undefined || poll !== null || values.host !== undefined))
    return { kind: "error", message: "--dir, --host and --poll read GitHub; not with --fake" };
  if (values.host !== undefined) {
    try {
      githubHost(values.host);
    } catch (error) {
      return { kind: "error", message: `--host: ${(error as Error).message}` };
    }
  }
  let allowHost: NamedHost | null = null;
  if (values["allow-host"] !== undefined) {
    try {
      allowHost = parseNamedHost(values["allow-host"]);
    } catch (error) {
      return { kind: "error", message: `--allow-host: ${(error as Error).message}` };
    }
  }
  const webUrl = values["web-url"] ?? null;
  if (webUrl !== null && !/^https?:\/\/[^/]+/.test(webUrl))
    return { kind: "error", message: "--web-url is an http(s) URL" };
  return {
    kind: "serve",
    flags: {
      fake: values.fake,
      scenario: scenario as Scenario,
      frozen: values.frozen,
      fakeUpdate: fakeUpdate as FakeUpdate,
      fakeService: fakeService as FakeService,
      fakeInstall: fakeInstall as FakeInstall,
      args: [...args],
      port,
      repo: values.repo ?? null,
      host: values.host ?? null,
      dir: values.dir ?? null,
      poll,
      webUrl,
      tokenFile: values["token-file"] ?? null,
      newToken: values["new-token"],
      newRemoteToken: values["new-remote-token"],
      open: values.open,
      allowHost,
      webDir: values["web-dir"] ?? null,
      inbox: values.inbox ?? null,
    },
  };
}

/**
 * The flags a service set up from the page runs with (ADR 0008): this
 * `nod serve`'s own, without those that must not repeat at every start:
 * `--open` (a browser at every start), `--new-token` and `--new-remote-token`
 * (every paired browser unpaired at every start), and `--no-open`, the default.
 */
export function serviceArgsOf(args: ReadonlyArray<string>): string[] {
  const once = new Set(["--open", "--no-open", "--new-token", "--new-remote-token"]);
  return args.filter((arg) => !once.has(arg));
}

async function runServe(flags: ServeFlags): Promise<number> {
  const { start } = await import("./server/start");
  const { defaultWebUrl, isRelease } = await import("./server/web-url");
  const { defaultTokenFile } = await import("./server/token");
  const { defaultWebRoot, isWebRoot } = await import("./server/static-files");
  const explicitWebUrl = flags.webUrl ?? process.env.NOD_WEB_URL ?? null;
  const webUrl = explicitWebUrl ?? defaultWebUrl(VERSION);
  // The app on loopback (ADR 0008), when there is a build; --allow-host needs one.
  const candidate = resolve(flags.webDir ?? defaultWebRoot());
  const webRoot = isWebRoot(candidate) ? candidate : null;
  if (!webRoot && (flags.webDir || flags.allowHost)) {
    console.error(
      flags.webDir
        ? `nod serve: there is no built web app in ${candidate} (no index.html).`
        : `nod serve: the web app for --allow-host is not built: run \`bun run build\` in this checkout (it writes ${candidate}), or pass --web-dir.`,
    );
    return 1;
  }
  let started: ReturnType<typeof start> | undefined;
  try {
    started = start({
      port: flags.port,
      webUrl,
      tokenFile: flags.tokenFile ?? defaultTokenFile(),
      newToken: flags.newToken,
      newRemoteToken: flags.newRemoteToken,
      version: VERSION,
      fake: flags.fake ? { scenario: flags.scenario, live: !flags.frozen } : null,
      repo: flags.repo,
      host: flags.host,
      ...(flags.dir !== null && { dir: flags.dir }),
      ...(flags.poll !== null && { pollMs: flags.poll * 1000 }),
      namedHost: flags.allowHost && webRoot ? { host: flags.allowHost, webRoot } : null,
      appRoot: webRoot,
      app: {
        serveArgs: serviceArgsOf(flags.args),
        fake: { update: flags.fakeUpdate, service: flags.fakeService, install: flags.fakeInstall },
        // The real seams; a fake run never calls this (`start()`).
        seams: () => realAppSeams(),
        onHandOver: () => {
          console.log(
            "\n  nod runs in the background now, as a service, on the same port; this nod serve stops.\n  see it with: nod service status\n",
          );
          void started?.stop().then(() => process.exit(0));
        },
      },
      ...(flags.inbox !== null && { inbox: { dir: resolve(flags.inbox) } }),
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

  const repos = started.source.repos();
  const host = repos[0]?.github.host ?? "github.com";
  const what = flags.fake
    ? `fake data (scenario ${flags.scenario})`
    : host === "github.com"
      ? "GitHub"
      : `GitHub on ${host}`;
  console.log(
    `nod serve on ${started.wsUrl} · ${what} · ${repos.map((r) => r.key).join(", ") || "no repo yet"}`,
  );
  if (!flags.fake && repos.length === 0)
    console.log(
      "\n  no repository yet: add one in the dashboard, or with `nod repo add owner/name`.",
    );
  const links = printedLinks({
    release: isRelease(VERSION),
    explicit: explicitWebUrl !== null,
    link: started.link,
    appLink: started.appLink,
  });
  console.log(`\n  open the dashboard:\n  ${links.main}\n`);
  if (links.app)
    console.log(`  or the app nod serve serves (install it from there):\n  ${links.app}\n`);
  if (started.deviceLink) {
    const { qrLines } = await import("./server/qr");
    console.log(
      `  on another device, through ${flags.allowHost!.origin}:\n  ${started.deviceLink}\n`,
    );
    console.log(
      qrLines(started.deviceLink)
        .map((line) => `  ${line}`)
        .join("\n"),
    );
    console.log(
      "\n  scan the code with that device's camera; do not send the link through a chat.\n",
    );
  }
  if (flags.newRemoteToken && !started.deviceLink)
    console.log("  the remote token was replaced: the other device pairs again.\n");
  console.log(
    started.deviceLink
      ? "  keep these links to yourself: while signing is unlocked on its side, each can sign.\n"
      : "  keep this link to yourself: while signing is unlocked, it can sign.\n",
  );
  if (flags.open) openBrowser(links.main);

  const stop = () => {
    void started.stop().then(() => process.exit(0));
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  return new Promise<number>(() => {});
}

/**
 * Which host link `nod serve` prints as the one to open (ADR 0008 §5): a
 * release's own app on loopback; a checkout's Vite dev server; `--web-url`
 * when given. The app's link, when it is served and not the main one, is
 * printed under it.
 */
export function printedLinks(input: {
  readonly release: boolean;
  /** `--web-url` or `NOD_WEB_URL` was given. */
  readonly explicit: boolean;
  /** The host link of the web url (hosted UI, dev server, or the given one). */
  readonly link: string;
  readonly appLink: string | null;
}): { main: string; app: string | null } {
  if (input.appLink && input.release && !input.explicit) return { main: input.appLink, app: null };
  return { main: input.link, app: input.appLink };
}

/** The real update feed, installer, channel store and service manager: only for a `nod serve` that is not `--fake`. */
function realAppSeams(): AppSeams {
  let entryPath: string | null = null;
  try {
    entryPath = realpathSync(process.argv[1] ?? "");
  } catch {
    // unknown: nod shows the commands only
  }
  return {
    feed: new GitHubReleaseFeed(),
    installer: createInstaller({ entryPath }),
    channelStore: jsonFileChannelStore(defaultConfigFile()),
    service: createServiceManager(),
    preflight: (hosts) => servicePreflight({ env: process.env, hosts }),
  };
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
    case "repo":
      return (await import("./server/repo-cli")).runRepo(cmd.flags);
    case "service": {
      const { runService, fetchHealth } = await import("./service/cli");
      const listed = () => readConfig(defaultConfigFile()).repos.map((r) => r.host);
      return runService(cmd.flags, {
        preflight: () =>
          servicePreflight({
            env: process.env,
            hosts: hostsToCheck(cmd.flags.serveArgs, listed()),
          }),
        health: fetchHealth,
      });
    }
    case "inbox":
      return (await import("./server/inbox/cli")).runInbox(cmd.flags, { version: VERSION });
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

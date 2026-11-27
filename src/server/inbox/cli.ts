/**
 * `nod inbox init | test | path`: my own inbox from a terminal (ADR 0009).
 *
 * - `init` writes the templates (`templates/inbox/`) into the folder,
 *   `$XDG_CONFIG_HOME/nod/inbox/`, never over a file that is there (unless
 *   `--force`).
 * - `test <pr>` runs the inbox on one pull request with the same runner
 *   `nod serve` uses (the subprocess, the timeouts, the I/O on this side),
 *   every analyzer, `poll` and `open`, and prints what the panel would show.
 *   The PR comes from GitHub (REST, `gh`'s token for its host), its objects
 *   into the `--dir` clone or nod's own (as `nod serve` fetches them), and
 *   the repo layer's result is nod's built-in policy's (not the verifier's).
 * - `path` prints the folder, and whether it has an `inbox.ts`.
 */

import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { parseArgs as parseFlags } from "node:util";

import { githubHost } from "../../kit/host.ts";
import { formatAttention, formatInsightState } from "../../kit/inbox/format.ts";
import { repoSummaryFromPolicy } from "../../kit/inbox/context.ts";
import type { InsightState, MyPullRequest, PersonalAttention } from "../../kit/inbox/types.ts";
import type { PullRequestInfo } from "../../kit/classifiers/types.ts";
import {
  defaultKitSpec,
  INBOX_TEMPLATES_DIR,
  isRelease,
  KIT_SPEC_PLACEHOLDER,
} from "../../init/setup-files.ts";
import { parseRepoInput } from "../../shared/repo-key";
import { cacheDir as defaultCacheDir, defaultConfigFile, readConfig } from "../config";
import { GitHubApi } from "../github/api";
import {
  clonePatchIds,
  OwnClone,
  ownClonePath,
  ownClonePatchIds,
  resolveClone,
  type PatchIds,
} from "../github/clone";
import { classifyLocally } from "../github/local";
import { ghToken } from "../github-source";
import { inboxDir } from "./paths";
import { InboxRunner } from "./runner";

export type InboxCommand = "init" | "test" | "path";

export interface InboxFlags {
  readonly command: InboxCommand;
  /** `--inbox`: the folder (default `$XDG_CONFIG_HOME/nod/inbox`). */
  readonly inbox: string | null;
  /** `init`: write over files that are there. */
  readonly force: boolean;
  /** `test`: the pull request as typed. */
  readonly pr: string | null;
  /** `test`: the clone to fetch into (default nod's own). */
  readonly dir: string | null;
  /** `test`: print JSON. */
  readonly json: boolean;
}

export const INBOX_HELP = `inbox commands (your own inbox: attention classifiers and analyzers that
only your nod serve runs, in $XDG_CONFIG_HOME/nod/inbox/):
  inbox init          write inbox.ts, analyzers/, package.json and
                      tsconfig.json there; never over a file that is there
    --force           write over them
  inbox test <pr>     run it on one pull request, every analyzer, and print
                      what the panel would show: <n> (with one repository),
                      owner/name#<n>, host/owner/name#<n> or the PR's URL
    --dir <path>      fetch the PR into this clone (default nod's own)
    --json            print JSON
  inbox path          print the folder, and whether it has an inbox.ts
  --inbox <path>      with any of them: another folder
`;

export function parseInboxArgs(
  args: readonly string[],
): { kind: "inbox"; flags: InboxFlags } | { kind: "help" } | { kind: "error"; message: string } {
  let parsed;
  try {
    parsed = parseFlags({
      args: [...args],
      strict: true,
      allowPositionals: true,
      options: {
        force: { type: "boolean", default: false },
        inbox: { type: "string" },
        dir: { type: "string" },
        json: { type: "boolean", default: false },
        help: { type: "boolean", short: "h", default: false },
      },
    });
  } catch (error) {
    return { kind: "error", message: error instanceof Error ? error.message : String(error) };
  }
  const { values, positionals } = parsed;
  if (values.help) return { kind: "help" };
  const [command, ...rest] = positionals;
  if (command !== "init" && command !== "test" && command !== "path")
    return { kind: "error", message: "nod inbox: init, test <pr> or path" };
  if (command === "test" && rest.length !== 1)
    return { kind: "error", message: "nod inbox test: name one pull request, e.g. owner/name#123" };
  if (command !== "test" && rest.length)
    return { kind: "error", message: `nod inbox ${command} takes no arguments` };
  if (values.force && command !== "init") return { kind: "error", message: "--force is for init" };
  if ((values.dir !== undefined || values.json) && command !== "test")
    return { kind: "error", message: "--dir and --json are for test" };
  return {
    kind: "inbox",
    flags: {
      command,
      inbox: values.inbox ?? null,
      force: values.force,
      pr: rest[0] ?? null,
      dir: values.dir ?? null,
      json: values.json,
    },
  };
}

/** Test seams; every default is the real thing. */
export interface InboxDeps {
  /** The CLI's version, for the package.json pin. */
  readonly version: string;
  /** The commit a checkout runs from, for the pin; default `git rev-parse HEAD` next to this file. */
  readonly gitHead?: () => string | null;
  readonly out?: (line: string) => void;
  readonly err?: (line: string) => void;
  readonly cwd?: string;
  readonly configFile?: string;
  readonly cacheDir?: string;
  readonly token?: (host: string) => string | null;
  /** Reads the PR, my login and my open PRs in its repo (default: REST on its host). */
  readonly readPr?: (input: {
    host: string;
    name: string;
    number: number;
    token: string;
  }) => Promise<PrRead>;
  /** Where the clone fetches from (default its remote; tests: a local repo). */
  readonly remote?: string;
  readonly runnerEntry?: string;
}

/** What `test` reads of a PR from GitHub. */
export interface PrRead {
  readonly pr: PullRequestInfo;
  readonly state: "open" | "draft" | "closed" | "merged";
  readonly me: string;
  readonly myWork: MyPullRequest[];
}

export async function runInbox(flags: InboxFlags, deps: InboxDeps): Promise<number> {
  const out = deps.out ?? ((line: string) => console.log(line));
  const err = deps.err ?? ((line: string) => console.error(line));
  const dir = resolve(deps.cwd ?? process.cwd(), flags.inbox ?? inboxDir());
  try {
    switch (flags.command) {
      case "path":
        out(dir);
        out(
          existsSync(join(dir, "inbox.ts"))
            ? "  inbox.ts: yours, nod serve runs exactly what it lists"
            : "  no inbox.ts: nod serve runs the built-in defaults (nod inbox init writes one)",
        );
        return 0;
      case "init":
        return await init(dir, flags.force, deps, out, err);
      case "test":
        return await test(dir, flags, deps, out, err);
    }
  } catch (error) {
    err(`nod inbox: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

// -- init ----------------------------------------------------------------------

/** The inbox templates, path → content, with the kit pinned to `kitSpec`. */
export async function inboxTemplates(
  kitSpec: string,
): Promise<Array<{ path: string; content: string }>> {
  const files: Array<{ path: string; content: string }> = [];
  for (const e of await readdir(INBOX_TEMPLATES_DIR, { recursive: true, withFileTypes: true })) {
    if (!e.isFile()) continue;
    const full = join(e.parentPath, e.name);
    const stored = relative(INBOX_TEMPLATES_DIR, full).split(sep).join("/");
    // A `tsconfig.json` in the package would steer bun's own resolution of the template.
    const path = stored === "tsconfig.editor.json" ? "tsconfig.json" : stored;
    let content = await readFile(full, "utf8");
    if (path === "package.json") content = content.replace(KIT_SPEC_PLACEHOLDER, kitSpec);
    files.push({ path, content });
  }
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

function kitSpecOf(deps: InboxDeps): string {
  if (isRelease(deps.version)) return defaultKitSpec(deps.version, null);
  const head =
    deps.gitHead?.() ??
    (() => {
      const r = Bun.spawnSync(["git", "-C", import.meta.dir, "rev-parse", "HEAD"], {
        stdout: "pipe",
        stderr: "pipe",
      });
      return r.exitCode === 0 ? r.stdout.toString().trim() : null;
    })();
  try {
    return defaultKitSpec(deps.version, head);
  } catch {
    // Only the editor's types read the pin; a checkout without a commit gets the latest release.
    return "latest";
  }
}

async function init(
  dir: string,
  force: boolean,
  deps: InboxDeps,
  out: (line: string) => void,
  err: (line: string) => void,
): Promise<number> {
  const files = await inboxTemplates(kitSpecOf(deps));
  const there = files.filter((f) => existsSync(join(dir, f.path)));
  if (there.length && !force) {
    err(
      `nod inbox init: ${dir} has ${there.map((f) => f.path).join(", ")} already; nothing was written. Pass --force to write over ${there.length === 1 ? "it" : "them"}.`,
    );
    return 1;
  }
  for (const f of files) {
    await mkdir(dirname(join(dir, f.path)), { recursive: true });
    await writeFile(join(dir, f.path), f.content);
  }
  out(`wrote ${files.map((f) => f.path).join(", ")} to ${dir}`);
  out("");
  out("  nod serve loads inbox.ts on every save. Try it on one pull request:");
  out("    nod inbox test owner/name#123");
  out(`  for your editor's types: cd ${dir} && bun install`);
  return 0;
}

// -- test ----------------------------------------------------------------------

/** The PR a person typed: `<n>`, `owner/name#<n>`, `host/owner/name#<n>` or its URL. */
export function parsePrInput(
  input: string,
): { repo: { host: string; name: string } | null; number: number } | null {
  const s = input.trim();
  const bare = /^#?(\d+)$/.exec(s);
  if (bare) return { repo: null, number: Number(bare[1]) };
  const url = /^https?:\/\/.+\/pull\/(\d+)(?:[/?#].*)?$/i.exec(s);
  if (url) {
    const repo = parseRepoInput(s);
    return repo ? { repo: { host: repo.host, name: repo.name }, number: Number(url[1]) } : null;
  }
  const ref = /^(.+)#(\d+)$/.exec(s);
  if (ref) {
    const repo = parseRepoInput(ref[1]!);
    return repo ? { repo: { host: repo.host, name: repo.name }, number: Number(ref[2]) } : null;
  }
  return null;
}

async function test(
  dir: string,
  flags: InboxFlags,
  deps: InboxDeps,
  out: (line: string) => void,
  err: (line: string) => void,
): Promise<number> {
  const parsed = parsePrInput(flags.pr ?? "");
  if (!parsed || parsed.number < 1)
    throw new Error(
      `${flags.pr} is not a pull request: <n>, owner/name#<n>, host/owner/name#<n> or its URL`,
    );
  const cwd = deps.cwd ?? process.cwd();

  // Which repo, and the clone its objects go into.
  const clone = flags.dir ? resolveClone(resolve(cwd, flags.dir), null, null) : null;
  let repo = parsed.repo;
  if (!repo && clone) repo = { host: clone.host.name, name: clone.repo };
  if (!repo) {
    const list = readConfig(deps.configFile ?? defaultConfigFile()).repos;
    if (list.length !== 1)
      throw new Error(
        list.length
          ? `your list has ${list.length} repositories: name one, owner/name#${parsed.number}`
          : `name the repository: owner/name#${parsed.number}`,
      );
    repo = { host: list[0]!.host, name: list[0]!.repo };
  }
  const host = githubHost(repo.host);
  const token = (deps.token ?? ghToken)(host.name);
  if (!token)
    throw new Error(
      `\`gh\` is not logged in to ${host.name}: run \`gh auth login --hostname ${host.name}\``,
    );

  const read = await (deps.readPr ?? readPrRest)({
    host: host.name,
    name: repo.name,
    number: parsed.number,
    token,
  });
  if (read.state !== "open" && read.state !== "draft")
    throw new Error(
      `${repo.name}#${parsed.number} is ${read.state}; the inbox runs on open pull requests`,
    );

  // Its objects, fetched as nod serve fetches them; the patch-id's base tip.
  let ids: PatchIds;
  if (clone) {
    if (clone.repo.toLowerCase() !== repo.name.toLowerCase())
      throw new Error(`${clone.dir} is a clone of ${clone.repo}, not ${repo.name}`);
    ids = clonePatchIds(clone, () => token, deps.remote);
  } else {
    const own = new OwnClone({
      dir: ownClonePath(deps.cacheDir ?? defaultCacheDir(), host.name, repo.name),
      host,
      name: repo.name,
      token: () => token,
      ...(deps.remote && { url: deps.remote }),
    });
    ids = ownClonePatchIds(own, host);
  }
  const target = { base: read.pr.base, headSha: read.pr.head_sha };
  const patchId = await ids.compute(target);
  const subject = await ids.inbox?.(target);
  if (!subject) throw new Error("the PR's objects are not in the clone");

  const local = await classifyLocally({
    repo: repo.name,
    number: read.pr.number,
    title: read.pr.title,
    body: read.pr.body,
    author: read.pr.author,
    base: read.pr.base,
    headSha: read.pr.head_sha,
    files: subject.files.map((f) => ({ path: f.path, additions: f.added, deletions: f.removed })),
    totalFiles: subject.files.length,
  });
  const job = {
    input: {
      pr: read.pr,
      files: subject.files,
      me: read.me,
      myWork: read.myWork,
      repoSummary: repoSummaryFromPolicy(local),
    },
    revs: subject.io.revs,
    patchId,
  };

  const runner = new InboxRunner({
    dir,
    watch: false,
    size: 1,
    log: err,
    ...(deps.runnerEntry && { entry: deps.runnerEntry }),
  });
  runner.start();
  try {
    await runner.ready();
    const status = runner.status();
    if (status.state === "error") {
      err(`nod inbox: ${status.error}`);
      return 1;
    }
    const prepared = await runner.prepare(job, subject.io);
    if (!prepared) throw new Error("the inbox did not run");
    const insights: InsightState[] = [];
    for (const a of prepared.analyzers) {
      const state = await runner.analyze(job, a, subject.io);
      if (state) insights.push(state);
    }
    if (flags.json) {
      out(JSON.stringify({ inbox: status, attention: prepared.attention, insights }, null, 2));
      return 0;
    }
    print(
      out,
      `${repo.name}#${read.pr.number}`,
      read.pr,
      status.config,
      dir,
      prepared.attention,
      insights,
    );
    return 0;
  } finally {
    runner.stop();
  }
}

function print(
  out: (line: string) => void,
  ref: string,
  pr: PullRequestInfo,
  config: "default" | "yours",
  dir: string,
  attention: PersonalAttention,
  insights: InsightState[],
) {
  out(`${ref} · ${pr.title} · ${pr.author}`);
  out(
    config === "yours"
      ? `inbox: ${join(dir, "inbox.ts")}`
      : "inbox: the built-in defaults (no inbox.ts)",
  );
  out("");
  out(formatAttention(attention));
  for (const s of insights) {
    out("");
    out(formatInsightState(s));
  }
  if (insights.length === 0) out("\nno analyzer applies to this pull request");
}

/** The PR, my login and my open PRs in the repo, over REST on the PR's host. */
export async function readPrRest(input: {
  host: string;
  name: string;
  number: number;
  token: string;
}): Promise<PrRead> {
  const api = new GitHubApi({
    token: input.token,
    host: githubHost(input.host),
    now: () => Date.now(),
  });
  type Pull = {
    number: number;
    title: string;
    body: string | null;
    state: string;
    draft?: boolean;
    merged_at?: string | null;
    user: { login: string } | null;
    labels?: Array<{ name: string }>;
    base: { ref: string };
    head: { sha: string };
  };
  const pull = (await api.rest<Pull>("GET", `/repos/${input.name}/pulls/${input.number}`)).data;
  const me = (await api.rest<{ login: string }>("GET", "/user")).data.login;
  const mine = (
    await api.rest<Pull[]>("GET", `/repos/${input.name}/pulls?state=open&per_page=100`)
  ).data.filter((p) => p.user?.login.toLowerCase() === me.toLowerCase());
  const myWork: MyPullRequest[] = [];
  for (const p of mine.slice(0, 10)) {
    const files = (
      await api.rest<Array<{ filename: string }>>(
        "GET",
        `/repos/${input.name}/pulls/${p.number}/files?per_page=100`,
      )
    ).data;
    myWork.push({
      repo: input.name,
      number: p.number,
      title: p.title,
      files: files.map((f) => f.filename),
    });
  }
  return {
    pr: {
      repo: input.name,
      number: pull.number,
      title: pull.title,
      body: pull.body ?? "",
      author: pull.user?.login ?? "ghost",
      labels: (pull.labels ?? []).map((l) => l.name),
      base: pull.base.ref,
      head_sha: pull.head.sha,
    },
    state: pull.merged_at
      ? "merged"
      : pull.state === "closed"
        ? "closed"
        : pull.draft
          ? "draft"
          : "open",
    me,
    myWork,
  };
}

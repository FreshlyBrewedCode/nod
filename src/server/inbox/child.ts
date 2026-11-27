/**
 * The inbox subprocess (ADR 0009 decision 8): loads my `inbox.ts`, or the
 * kit's defaults when there is none, and runs classifiers and analyzers for
 * `nod serve` over JSON lines on stdio (`wire.ts`). Started by `process.ts`
 * with the runtime that runs nod and a scrubbed environment (`env.ts`):
 *
 *   bun --no-install child.ts <inbox folder>
 *
 * - `@frebreco/nod/kit/inbox` (and `/kit`) in the folder's files resolve to
 *   the kit of the nod that runs this, whatever `node_modules` has: the
 *   folder's `package.json` is for the editor's types. `--no-install` keeps
 *   bun from fetching a package an import names.
 * - The context's I/O goes back to the server (`io` requests): reads,
 *   diffs and git run there, with the host's credentials, which never come
 *   here.
 * - stdout is the protocol: `console.log` and friends go to stderr, which
 *   the server logs. Not a sandbox: this runs as the user, with the user's
 *   files and network.
 */

import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { createInboxContext } from "../../kit/inbox/context.ts";
import { defaultInbox } from "../../kit/inbox/defaults.ts";
import { classifierName, defineInbox, inboxFor } from "../../kit/inbox/define.ts";
import {
  analyzerApplies,
  errorMessage,
  evaluateAttention,
  insightCacheKey,
  runAnalyzer,
} from "../../kit/inbox/run.ts";
import type { Inbox, InboxIO } from "../../kit/inbox/types.ts";
import { INBOX_FILE } from "./paths.ts";
import type { FromChild, IoOp, JobInput, LoadedInbox, ToChild } from "./wire.ts";

const KIT = {
  "@frebreco/nod/kit/inbox": resolve(import.meta.dir, "../../kit/inbox/index.ts"),
  "@frebreco/nod/kit": resolve(import.meta.dir, "../../kit/index.ts"),
};

const out = process.stdout;

/** The protocol owns stdout: everything printed goes to stderr. */
function quietStdout(): void {
  const toStderr = (...args: unknown[]) => console.error(...args);
  console.log = toStderr;
  console.info = toStderr;
  console.debug = toStderr;
  console.warn = toStderr;
}

function send(message: FromChild): void {
  out.write(`${JSON.stringify(message)}\n`);
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");

/**
 * Points the kit's specifiers in the folder's own files at this nod's kit,
 * by rewriting them as they load (a runtime `onResolve` does not see bare
 * specifiers in Bun). Files in `node_modules` are left alone.
 */
function mapKit(dir: string): void {
  const filter = new RegExp(`^${escape(dir)}/(?!node_modules/).*\\.(ts|mts|tsx|js|mjs)$`);
  const pattern = /(["'])(@frebreco\/nod\/kit(?:\/inbox)?)\1/g;
  Bun.plugin({
    name: "nod-kit",
    setup(build) {
      build.onLoad({ filter }, async (args) => {
        const text = await Bun.file(args.path).text();
        const contents = text.replace(pattern, (_, _q, spec: keyof typeof KIT) =>
          JSON.stringify(KIT[spec]),
        );
        const ext = args.path.slice(args.path.lastIndexOf(".") + 1);
        const loader = ext === "tsx" ? "tsx" : ext === "js" || ext === "mjs" ? "js" : "ts";
        return { contents, loader };
      });
    },
  });
}

/** What the folder holds: my inbox, or the defaults. Throws with a sentence when it does not load. */
async function load(dir: string): Promise<{ inbox: Inbox; loaded: LoadedInbox }> {
  const file = join(dir, INBOX_FILE);
  if (!existsSync(file)) {
    const inbox = defaultInbox();
    return { inbox, loaded: describe(inbox, "default", null) };
  }
  mapKit(dirname(file));
  let mod: { default?: unknown };
  try {
    mod = (await import(file)) as { default?: unknown };
  } catch (e) {
    throw new Error(`${INBOX_FILE} does not load: ${loadMessage(e, dirname(file))}`);
  }
  const value = mod.default;
  if (typeof value !== "object" || value === null)
    throw new Error(`${INBOX_FILE} must \`export default defineInbox({ … })\``);
  // A plain object works too; defineInbox checks it either way.
  const v = value as Partial<Inbox>;
  const inbox = defineInbox({
    ...(v.classifiers !== undefined && { classifiers: v.classifiers }),
    ...(v.analyzers !== undefined && { analyzers: v.analyzers }),
    ...(v.repos !== undefined && { repos: v.repos }),
  });
  return { inbox, loaded: describe(inbox, "yours", file) };
}

/**
 * A load error in one line, with where it is when that is in the folder:
 * `Unexpected end of file (inbox.ts:3:12)`. A line inside the kit (a
 * `defineInbox` check) is not mine to look at, so it is left out.
 */
function loadMessage(e: unknown, dir: string): string {
  const text = errorMessage(e);
  const rel = (file: string) => (file.startsWith(`${dir}/`) ? file.slice(dir.length + 1) : null);
  const position = (e as { position?: { file?: string; line?: number; column?: number } | null })
    ?.position;
  if (position?.file && rel(position.file) && position.line)
    return `${text} (${rel(position.file)}:${position.line}:${(position.column ?? 0) + 1})`;
  const stack = e instanceof Error ? (e.stack ?? "") : "";
  for (const m of stack.matchAll(/\(?((?:\/[^\s():]+)+):(\d+):(\d+)\)?/g)) {
    const file = rel(m[1]!);
    if (file) return `${text} (${file}:${m[2]}:${m[3]})`;
  }
  return text;
}

function describe(inbox: Inbox, config: "default" | "yours", file: string | null): LoadedInbox {
  const classifiers: LoadedInbox["classifiers"][number][] = [];
  const analyzers: LoadedInbox["analyzers"][number][] = [];
  const add = (parts: Partial<Inbox>, repos?: string) => {
    for (const c of parts.classifiers ?? [])
      classifiers.push({
        name: classifierName(c),
        origin: c.origin ?? "yours",
        ...(repos && { repos }),
      });
    for (const a of parts.analyzers ?? [])
      analyzers.push({
        id: a.id,
        title: a.title,
        when: a.when,
        origin: a.origin,
        ...(repos && { repos }),
      });
  };
  add(inbox);
  for (const [key, parts] of Object.entries(inbox.repos)) add(parts, key);
  return { config, file, classifiers, analyzers };
}

// -- I/O, answered by the server ---------------------------------------------

let nextIo = 1;
const waiting = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

function ask(job: number, op: IoOp, args: unknown[]): Promise<unknown> {
  const id = nextIo++;
  return new Promise((resolve, reject) => {
    waiting.set(id, { resolve, reject });
    send({ t: "io", id, job, op, args });
  });
}

function ioFor(job: number, revs: JobInput["revs"]): InboxIO {
  return {
    revs,
    readBaseFile: (path) => ask(job, "readBaseFile", [path]) as Promise<string | null>,
    readHeadFile: (path) => ask(job, "readHeadFile", [path]) as Promise<string | null>,
    diff: (paths) => ask(job, "diff", paths ? [[...paths]] : []) as Promise<string>,
    git: (args) => ask(job, "git", [[...args]]) as Promise<string>,
  };
}

// -- jobs ----------------------------------------------------------------------

async function handle(inbox: Inbox, m: ToChild): Promise<void> {
  if (m.t === "io-result") {
    const w = waiting.get(m.id);
    if (!w) return;
    waiting.delete(m.id);
    if (m.ok) w.resolve(m.value ?? null);
    else w.reject(new Error(m.error ?? "failed"));
    return;
  }
  try {
    const ctx = createInboxContext(m.input, ioFor(m.id, m.revs));
    const parts = inboxFor(inbox, m.input.pr.repo);
    if (m.t === "prepare") {
      const attention = await evaluateAttention(parts.classifiers, ctx);
      const analyzers = parts.analyzers
        .filter((a) => analyzerApplies(a, ctx))
        .map((a) => ({
          id: a.id,
          title: a.title,
          when: a.when,
          origin: a.origin,
          key: insightCacheKey(a, m.patchId, ctx),
        }));
      send({ t: "prepared", id: m.id, attention, analyzers });
      return;
    }
    const analyzer = parts.analyzers.find((a) => a.id === m.analyzer);
    if (!analyzer) throw new Error(`no analyzer ${m.analyzer} for ${m.input.pr.repo}`);
    const state = await runAnalyzer(analyzer, ctx, { timeoutMs: m.timeoutMs });
    send({ t: "analyzed", id: m.id, state });
  } catch (e) {
    send({ t: "failed", id: m.id, error: errorMessage(e) });
  }
}

async function main(): Promise<void> {
  quietStdout();
  const dir = resolve(process.argv[2] ?? ".");
  let inbox: Inbox;
  try {
    const result = await load(dir);
    inbox = result.inbox;
    send({ t: "hello", inbox: result.loaded });
  } catch (e) {
    send({ t: "hello", error: errorMessage(e) });
    return;
  }
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of Bun.stdin.stream()) {
    buffer += decoder.decode(chunk, { stream: true });
    let nl: number;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      if (!line.trim()) continue;
      let message: ToChild;
      try {
        message = JSON.parse(line) as ToChild;
      } catch {
        continue;
      }
      void handle(inbox, message);
    }
  }
  // stdin closed: nod serve is gone. A pending timer of an analyzer must not keep this alive.
  process.exit(0);
}

if (import.meta.main) await main();

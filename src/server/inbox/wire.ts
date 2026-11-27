/**
 * The runner's protocol (ADR 0009 decision 8): JSON lines over the inbox
 * subprocess's stdio, one message per line. The server sends one job at a
 * time to a process; while it runs, the job's git I/O comes back as `io`
 * requests, which the server answers from its side (`io-result`), so the
 * subprocess never holds a token or a handle to the clone.
 *
 *   server ──stdin──▶ child:  prepare | analyze | io-result
 *   child ──stdout──▶ server: hello | prepared | analyzed | io
 *
 * Everything the child sends is checked again on the server's side
 * (`parseAttention`, `parseInsightState`, {@link parsePlan}): what the
 * subprocess claims is never trusted. A line that is not a message (an
 * analyzer printing to stdout) is logged, never parsed as one.
 */

import { cleanString } from "../../kit/inbox/validate.ts";
import { ANALYZER_ID } from "../../kit/inbox/define.ts";
import type { InboxInput } from "../../kit/inbox/context.ts";
import type { InboxAnalyzer, InboxClassifier } from "../../shared/protocol";

/** The base tip and the head, as the clone names them (`InboxIO.revs`). */
export interface Revs {
  readonly base: string;
  readonly head: string;
}

/** One PR, as a job carries it. */
export interface JobInput {
  readonly input: InboxInput;
  readonly revs: Revs;
  readonly patchId: string;
}

/** The I/O a job may ask for: the `InboxIO` methods. */
export type IoOp = "readBaseFile" | "readHeadFile" | "diff" | "git";

/** server → child */
export type ToChild =
  /** Run the classifiers and say which analyzers apply, with their cache keys. */
  | ({ readonly t: "prepare"; readonly id: number } & JobInput)
  /** Run one analyzer; the kit's `runAnalyzer` with `timeoutMs`. */
  | ({
      readonly t: "analyze";
      readonly id: number;
      readonly analyzer: string;
      readonly timeoutMs: number;
    } & JobInput)
  | {
      readonly t: "io-result";
      readonly id: number;
      readonly ok: boolean;
      readonly value?: string | null;
      readonly error?: string;
    };

/** What a child loaded: where from, and its parts. */
export interface LoadedInbox {
  /** `default`: there is no `inbox.ts`; `yours`: it loaded the file. */
  readonly config: "default" | "yours";
  readonly file: string | null;
  readonly classifiers: ReadonlyArray<InboxClassifier>;
  readonly analyzers: ReadonlyArray<InboxAnalyzer>;
}

/** An analyzer that applies to a PR, with its cache key (`insightCacheKey`). */
export interface PlannedAnalyzer {
  readonly id: string;
  readonly title: string;
  readonly when: "poll" | "open";
  readonly origin: "default" | "yours";
  readonly key: string;
}

/** child → server */
export type FromChild =
  | { readonly t: "hello"; readonly inbox: LoadedInbox }
  | { readonly t: "hello"; readonly error: string }
  | {
      readonly t: "prepared";
      readonly id: number;
      /** The `PersonalAttention`, unchecked. */
      readonly attention: unknown;
      readonly analyzers: unknown;
    }
  /** The `InsightState`, unchecked. */
  | { readonly t: "analyzed"; readonly id: number; readonly state: unknown }
  /** The job failed outside an analyzer (a bug in the child). */
  | { readonly t: "failed"; readonly id: number; readonly error: string }
  | {
      readonly t: "io";
      readonly id: number;
      readonly job: number;
      readonly op: IoOp;
      readonly args: ReadonlyArray<unknown>;
    };

/** Longest line the server reads from a child: a job's results are small; this is a bug. */
export const MAX_LINE = 4 * 1024 * 1024;

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

/** A line from a child as a message, or null when it is not one (it is then logged). */
export function parseFromChild(line: string): FromChild | null {
  let v: unknown;
  try {
    v = JSON.parse(line);
  } catch {
    return null;
  }
  if (!isObj(v) || typeof v.t !== "string") return null;
  switch (v.t) {
    case "hello":
      if (typeof v.error === "string") return { t: "hello", error: v.error };
      return isObj(v.inbox) ? { t: "hello", inbox: parseLoaded(v.inbox) } : null;
    case "prepared":
      return typeof v.id === "number"
        ? { t: "prepared", id: v.id, attention: v.attention, analyzers: v.analyzers }
        : null;
    case "analyzed":
      return typeof v.id === "number" ? { t: "analyzed", id: v.id, state: v.state } : null;
    case "failed":
      return typeof v.id === "number"
        ? { t: "failed", id: v.id, error: cleanString(v.error, 500) ?? "error" }
        : null;
    case "io": {
      const ops: readonly string[] = ["readBaseFile", "readHeadFile", "diff", "git"];
      if (typeof v.id !== "number" || typeof v.job !== "number") return null;
      if (typeof v.op !== "string" || !ops.includes(v.op) || !Array.isArray(v.args)) return null;
      return { t: "io", id: v.id, job: v.job, op: v.op as IoOp, args: v.args };
    }
    default:
      return null;
  }
}

const origin = (v: unknown): "default" | "yours" => (v === "default" ? "default" : "yours");
const when = (v: unknown): "poll" | "open" | null => (v === "poll" || v === "open" ? v : null);

/** What a child says it loaded, cleaned: names cut, unknown fields dropped. */
export function parseLoaded(v: Obj): LoadedInbox {
  const repos = (x: Obj) => {
    const r = cleanString(x.repos, 120);
    return r ? { repos: r } : {};
  };
  const classifiers = (Array.isArray(v.classifiers) ? v.classifiers : [])
    .filter(isObj)
    .slice(0, 100)
    .map((c) => ({
      name: cleanString(c.name, 80) ?? "classifier",
      origin: origin(c.origin),
      ...repos(c),
    }));
  const analyzers = (Array.isArray(v.analyzers) ? v.analyzers : [])
    .filter(isObj)
    .slice(0, 100)
    .flatMap((a) => {
      const w = when(a.when);
      const id = typeof a.id === "string" && ANALYZER_ID.test(a.id) ? a.id : null;
      if (!w || !id) return [];
      return [
        {
          id,
          title: cleanString(a.title, 80) ?? id,
          when: w,
          origin: origin(a.origin),
          ...repos(a),
        },
      ];
    });
  return {
    config: v.config === "yours" ? "yours" : "default",
    file: typeof v.file === "string" ? v.file.slice(0, 1000) : null,
    classifiers,
    analyzers,
  };
}

/** The analyzers a child planned for a PR, checked: ids well-formed and unique, keys short. */
export function parsePlan(v: unknown): PlannedAnalyzer[] {
  if (!Array.isArray(v)) return [];
  const seen = new Set<string>();
  const out: PlannedAnalyzer[] = [];
  for (const a of v.slice(0, 100)) {
    if (!isObj(a)) continue;
    const w = when(a.when);
    if (typeof a.id !== "string" || !ANALYZER_ID.test(a.id) || seen.has(a.id) || !w) continue;
    if (typeof a.key !== "string" || a.key.length > 500) continue;
    seen.add(a.id);
    out.push({
      id: a.id,
      title: cleanString(a.title, 80) ?? a.id,
      when: w,
      origin: origin(a.origin),
      key: a.key,
    });
  }
  return out;
}

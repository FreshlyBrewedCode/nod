/**
 * One inbox subprocess (`child.ts`), seen from the server: start it, wait
 * for its `hello`, send it one job at a time, answer its I/O, and kill it
 * when a job runs past its time (an analyzer stuck in a loop blocks its
 * whole process, so killing it is the only way out). `runner.ts` keeps a
 * few of these and restarts them.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";

import { errorMessage } from "../../kit/inbox/run.ts";
import type { InboxIO } from "../../kit/inbox/types.ts";
import {
  MAX_LINE,
  parseFromChild,
  type FromChild,
  type IoOp,
  type JobInput,
  type LoadedInbox,
  type ToChild,
} from "./wire.ts";

/** The child's entry file, shipped next to this one. */
export const CHILD_ENTRY = join(import.meta.dir, "child.ts");

export interface ProcessOptions {
  /** The inbox folder. */
  readonly dir: string;
  /** Its environment (`inboxEnv`). */
  readonly env: Record<string, string>;
  /** The runtime (default: the one running nod). */
  readonly execPath?: string;
  /** The entry (default {@link CHILD_ENTRY}); tests start a stand-in. */
  readonly entry?: string;
  /** How long it may take to load (default 20 s). */
  readonly startMs?: number;
  readonly log: (line: string) => void;
}

/** A job ran past its time; the process was killed. */
export class JobTimeout extends Error {
  override name = "JobTimeout";
}

/** The process exited (or was stopped) while a job ran. */
export class ProcessGone extends Error {
  override name = "ProcessGone";
}

type Result = Extract<FromChild, { t: "prepared" | "analyzed" }>;

interface Job {
  readonly id: number;
  readonly io: InboxIO;
  resolve(r: Result): void;
  reject(e: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

export class InboxProcess {
  private proc: ReturnType<typeof Bun.spawn> | null = null;
  private job: Job | null = null;
  private nextId = 1;
  private hello: Promise<LoadedInbox> | null = null;
  private killedByUs = false;
  /** Resolves when the process exited: `crashed` unless it was stopped or killed for a timeout. */
  readonly exited: Promise<{ crashed: boolean; code: number | null }>;
  private markExited!: (r: { crashed: boolean; code: number | null }) => void;
  /** The last lines it wrote to stderr, for a crash's message. */
  private lastErr: string[] = [];

  constructor(private readonly options: ProcessOptions) {
    this.exited = new Promise((r) => (this.markExited = r));
  }

  get busy(): boolean {
    return this.job !== null;
  }

  get alive(): boolean {
    return this.proc !== null && this.proc.exitCode === null && !this.killedByUs;
  }

  /** Starts it; resolves with what it loaded, rejects with the load error. */
  start(): Promise<LoadedInbox> {
    if (this.hello) return this.hello;
    const { dir, env, log } = this.options;
    const cwd = existsSync(dir) ? dir : (env.HOME ?? "/");
    this.hello = new Promise<LoadedInbox>((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(new Error("the inbox took too long to load"));
        this.kill();
      }, this.options.startMs ?? 20_000);
      const onHello = (m: FromChild & { t: "hello" }) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if ("error" in m) reject(new Error(m.error));
        else resolve(m.inbox);
      };
      try {
        this.proc = Bun.spawn({
          cmd: [
            this.options.execPath ?? process.execPath,
            "--no-install",
            this.options.entry ?? CHILD_ENTRY,
            dir,
          ],
          cwd,
          env,
          stdin: "pipe",
          stdout: "pipe",
          stderr: "pipe",
        });
      } catch (e) {
        settled = true;
        clearTimeout(timer);
        reject(new Error(`the inbox process did not start: ${errorMessage(e)}`));
        this.markExited({ crashed: true, code: null });
        return;
      }
      const proc = this.proc;
      void this.readLines(proc.stdout as ReadableStream<Uint8Array>, (line) => {
        const m = parseFromChild(line);
        if (!m) {
          if (line.trim()) log(`nod inbox: ${line.slice(0, 500)}`);
          return;
        }
        if (m.t === "hello") onHello(m);
        else this.receive(m);
      });
      void this.readLines(proc.stderr as ReadableStream<Uint8Array>, (line) => {
        if (!line.trim()) return;
        this.lastErr = [...this.lastErr, line].slice(-5);
        log(`nod inbox: ${line.slice(0, 500)}`);
      });
      void proc.exited.then((code) => {
        const crashed = !this.killedByUs;
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(new Error(this.crashText(code)));
        }
        this.failJob(new ProcessGone(this.crashText(code)));
        this.markExited({ crashed, code });
      });
    });
    return this.hello;
  }

  /** Why it ended, in a sentence: its last line on stderr, or the exit code. */
  private crashText(code: number | null): string {
    const last = this.lastErr.findLast((l) => /error/i.test(l)) ?? this.lastErr.at(-1);
    return `the inbox process exited${code === null ? "" : ` (code ${code})`}${last ? `: ${last.trim().slice(0, 300)}` : ""}`;
  }

  /** Runs one job; at most one at a time. Rejects with {@link JobTimeout} or {@link ProcessGone}. */
  run(
    message:
      | ({ t: "prepare" } & JobInput)
      | ({ t: "analyze"; analyzer: string; timeoutMs: number } & JobInput),
    io: InboxIO,
    timeoutMs: number,
    /** Past `timeoutMs` before the kill: the kit's own timeout answers first when it can. */
    graceMs = 0,
  ): Promise<Result> {
    if (this.job) return Promise.reject(new Error("busy"));
    if (!this.alive) return Promise.reject(new ProcessGone("the inbox process is not running"));
    const id = this.nextId++;
    return new Promise<Result>((resolve, reject) => {
      const timer = setTimeout(() => {
        const what = message.t === "analyze" ? message.analyzer : "the classifiers";
        this.failJob(
          new JobTimeout(
            `${what} did not finish within ${Math.round(timeoutMs / 1000)} s; the inbox process was restarted`,
          ),
        );
        this.kill();
      }, timeoutMs + graceMs);
      this.job = { id, io, resolve, reject, timer };
      this.write({ ...message, id } as ToChild);
    });
  }

  private receive(m: FromChild) {
    const job = this.job;
    if (m.t === "io") {
      if (!job || m.job !== job.id)
        return this.write({ t: "io-result", id: m.id, ok: false, error: "no such job" });
      void this.io(job.io, m.op, m.args).then(
        (value) => this.write({ t: "io-result", id: m.id, ok: true, value }),
        (e: unknown) => this.write({ t: "io-result", id: m.id, ok: false, error: errorMessage(e) }),
      );
      return;
    }
    if (m.t === "hello" || !job || m.id !== job.id) return;
    clearTimeout(job.timer);
    this.job = null;
    if (m.t === "failed") job.reject(new Error(m.error));
    else job.resolve(m);
  }

  /** The I/O a job asked for, on the server's side: arguments checked, the kit's I/O does the rest. */
  private async io(io: InboxIO, op: IoOp, args: ReadonlyArray<unknown>): Promise<string | null> {
    const strings = (v: unknown): string[] => {
      if (!Array.isArray(v) || !v.every((x) => typeof x === "string"))
        throw new Error("arguments must be strings");
      return v as string[];
    };
    switch (op) {
      case "readBaseFile":
      case "readHeadFile":
        if (typeof args[0] !== "string") throw new Error("path must be a string");
        return io[op](args[0]);
      case "diff":
        return io.diff(args[0] === undefined ? undefined : strings(args[0]));
      case "git":
        return io.git(strings(args[0]));
    }
  }

  private failJob(error: Error) {
    const job = this.job;
    if (!job) return;
    clearTimeout(job.timer);
    this.job = null;
    job.reject(error);
  }

  private write(message: ToChild) {
    const stdin = this.proc?.stdin;
    if (!stdin || typeof stdin === "number") return;
    try {
      stdin.write(`${JSON.stringify(message)}\n`);
      stdin.flush();
    } catch {
      // It is gone; `exited` tells.
    }
  }

  private async readLines(stream: ReadableStream<Uint8Array>, onLine: (line: string) => void) {
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      for await (const chunk of stream) {
        buffer += decoder.decode(chunk, { stream: true });
        let nl: number;
        while ((nl = buffer.indexOf("\n")) >= 0) {
          onLine(buffer.slice(0, nl));
          buffer = buffer.slice(nl + 1);
        }
        if (buffer.length > MAX_LINE) {
          this.options.log("nod inbox: a line longer than 4 MiB; the process is restarted");
          this.kill();
          return;
        }
      }
    } catch {
      // closed
    }
    if (buffer) onLine(buffer);
  }

  /** Kills it now (SIGKILL): a job still running fails. */
  kill(): void {
    this.killedByUs = true;
    try {
      this.proc?.kill(9);
    } catch {
      // gone already
    }
    this.failJob(new ProcessGone("the inbox process was stopped"));
  }
}

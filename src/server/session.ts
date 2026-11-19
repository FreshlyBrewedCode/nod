/**
 * The protocol's server side: every open tab is a client; requests go to the
 * source (GitHub, or the fake) and the signer; every change is pushed to all
 * tabs. The socket plumbing and the token live in `server.ts`.
 */

import type {
  Account,
  ClientToServer,
  ErrorCode,
  KeyInfo,
  RequestError,
  RequestResult,
  RequestType,
  ServerToClient,
  SignEntry,
  SignerState,
  Welcome,
} from "../shared/protocol";
import { ghLoginCommand } from "../kit/host.ts";
import { PROTOCOL_VERSION } from "../shared/protocol";
import type { Clock } from "./clock";
import { commentBody, humanLine, payloadLine } from "./payload";
import { SignerError, type Signer, type SignerKey } from "./signer";
import { SourceError, type NodPayload, type Source } from "./source";

/** One open tab. `send` takes the serialised message. */
export interface Client {
  send(data: string): void;
}

export interface SessionOptions {
  readonly source: Source;
  readonly signer: Signer;
  readonly clock: Clock;
  /** The published version; null for a checkout. */
  readonly version: string | null;
  readonly fake: boolean;
}

/** A request that failed in a way the user should see. */
export class RequestFailure extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly details?: RequestError["details"],
  ) {
    super(message);
  }
}

/** The most PRs one nod may cover. */
export const MAX_BATCH = 100;

type Handlers = {
  [K in RequestType]: (message: Extract<ClientToServer, { t: K }>) => Promise<RequestResult<K>>;
};

export class Session {
  private readonly clients = new Set<Client>();
  /** Connected, welcome not sent yet. */
  private readonly joining = new Set<Client>();
  private readonly unsubscribe: Array<() => void>;
  private account: Account | null | undefined;
  private readonly handlers: Handlers;

  constructor(private readonly options: SessionOptions) {
    const { source, signer } = options;
    this.unsubscribe = [
      source.subscribe((change) => {
        if (change === "prs") this.pushSnapshot();
        else if (change === "setup") void this.pushSetup();
        else this.pushSigner();
      }),
      signer.subscribe(() => this.pushSigner()),
    ];
    this.handlers = this.makeHandlers();
  }

  /** A tab connected: welcome, then the snapshot; from then on every push. */
  async attach(client: Client): Promise<void> {
    this.joining.add(client);
    const welcome = await this.welcome();
    if (!this.joining.delete(client)) return; // closed meanwhile
    client.send(JSON.stringify(welcome));
    this.clients.add(client);
    const snapshot = this.options.source.snapshot();
    if (snapshot)
      client.send(JSON.stringify({ t: "snapshot", ...snapshot } satisfies ServerToClient));
  }

  detach(client: Client): void {
    this.joining.delete(client);
    this.clients.delete(client);
  }

  get clientCount(): number {
    return this.clients.size;
  }

  /** One message from a tab. Every request gets exactly one reply. */
  async handle(client: Client, data: string): Promise<void> {
    let message: ClientToServer;
    try {
      message = parseRequest(data);
    } catch (error) {
      const id = requestId(data);
      if (id === null) return; // not even a request: nothing to answer
      return this.reply(client, {
        t: "reply",
        id,
        to: requestType(data) ?? "refresh",
        ok: false,
        error: toRequestError(error),
      } as ServerToClient);
    }
    try {
      const handler = this.handlers[message.t] as (m: ClientToServer) => Promise<unknown>;
      const result = await handler(message);
      this.reply(client, {
        t: "reply",
        id: message.id,
        to: message.t,
        ok: true,
        result,
      } as ServerToClient);
    } catch (error) {
      this.reply(client, {
        t: "reply",
        id: message.id,
        to: message.t,
        ok: false,
        error: toRequestError(error),
      } as ServerToClient);
    }
  }

  stop(): void {
    for (const off of this.unsubscribe) off();
    this.clients.clear();
    this.joining.clear();
  }

  // -- pushes ---------------------------------------------------------------

  private broadcast(message: ServerToClient) {
    const data = JSON.stringify(message);
    for (const client of this.clients) client.send(data);
  }

  private reply(client: Client, message: ServerToClient) {
    client.send(JSON.stringify(message));
  }

  private pushSnapshot() {
    const snapshot = this.options.source.snapshot();
    if (snapshot) this.broadcast({ t: "snapshot", ...snapshot });
  }

  private async pushSetup() {
    this.broadcast({ t: "setup", setup: await this.options.source.setup() });
  }

  private pushSigner() {
    this.broadcast({ t: "signer", signer: this.signerState() });
  }

  private async me(): Promise<Account | null> {
    if (this.account === undefined) this.account = await this.options.source.account();
    return this.account;
  }

  private async welcome(): Promise<Welcome> {
    const { source, version, fake } = this.options;
    return {
      t: "welcome",
      protocol: PROTOCOL_VERSION,
      version,
      fake,
      me: await this.me(),
      repo: source.repo(),
      github: source.github(),
      setup: await source.setup(),
      signer: this.signerState(),
    };
  }

  /** The signer's state, with the enrolment the repo decides. */
  signerState(): SignerState {
    const status = this.options.signer.status();
    if (status.state === "no-key") return status;
    return { ...status, key: this.keyInfo(status.key) };
  }

  private keyInfo(key: SignerKey): KeyInfo {
    return { ...key, enrolment: this.options.source.enrolment(key.publicKey) };
  }

  // -- requests ---------------------------------------------------------------

  private makeHandlers(): Handlers {
    const { source, signer, clock } = this.options;
    const needRepo = () => {
      const repo = source.repo();
      if (!repo) throw new RequestFailure("no-repo", "Pick a repository first.");
      return repo;
    };
    const needMe = async () => {
      const me = await this.me();
      if (!me) {
        const { host } = source.github();
        throw new RequestFailure(
          "github",
          `\`gh\` is not logged in to ${host}. Run \`${ghLoginCommand(host)}\`.`,
        );
      }
      return me;
    };
    const needKey = () => {
      const status = signer.status();
      if (status.state === "no-key")
        throw new RequestFailure("no-key", "There is no signing key yet.");
      return status;
    };

    return {
      unlock: async ({ passphrase, minutes, once }) => {
        await signer.unlock(passphrase, {
          ...(minutes !== undefined && { minutes }),
          ...(once !== undefined && { once }),
        });
        const status = signer.status();
        return { until: status.state === "unlocked" ? status.until : clock.now() };
      },
      lock: async () => {
        signer.lock();
        return {};
      },
      sign: async ({ entries, verdict, note }) => {
        const repo = needRepo();
        const me = await needMe();
        const status = needKey();
        const enrolment = source.enrolment(status.key.publicKey);
        if (enrolment.state === "pending")
          throw new RequestFailure(
            "key-pending",
            `Your key is pending${enrolment.pr ? ` until #${enrolment.pr.number} merges` : ""}; it cannot sign yet.`,
          );
        if (enrolment.state === "not-enrolled")
          throw new RequestFailure(
            "key-pending",
            `Your key is not enrolled in ${repo}; it cannot sign yet.`,
          );
        if (status.state !== "unlocked")
          throw new RequestFailure("locked", "Unlock signing first.");

        const stale: { pr: number; signed: string; current: string }[] = [];
        const built: NodPayload["entries"][number][] = [];
        for (const entry of entries) {
          const target = await source.signTarget(entry.pr);
          if (!target) throw new RequestFailure("not-found", `#${entry.pr} is not in ${repo}.`);
          if (target.state !== "open")
            throw new RequestFailure(
              "not-open",
              `#${entry.pr} is ${target.state}; only open PRs can be nodded.`,
            );
          if (target.headSha !== entry.head_sha) {
            stale.push({ pr: entry.pr, signed: entry.head_sha, current: target.headSha });
            continue;
          }
          if (!target.patchId)
            throw new RequestFailure(
              "no-patch-id",
              `The patch-id of #${entry.pr} is not known yet; try again in a moment.`,
            );
          built.push({
            pr: entry.pr,
            base: target.base,
            head_sha: target.headSha,
            patch_id: target.patchId,
          });
        }
        if (stale.length)
          throw new RequestFailure(
            "stale",
            `${stale.map((s) => `#${s.pr}`).join(", ")} changed since you looked. Nothing was signed.`,
            { stale },
          );

        const payload: NodPayload = {
          v: 1,
          repo,
          entries: built,
          verdict,
          level: "review",
          reviewer: me.login,
          signed_at: new Date(clock.now()).toISOString(),
        };
        const line = payloadLine(payload);
        const signature = await signer.sign(line);
        const body = commentBody(line, signature, humanLine(payload, note));
        const results = await source.postNod({ payload, line, signature, body });
        return {
          payload: line,
          posted: results.filter((r) => r.ok).map((r) => ({ pr: r.pr, url: r.url ?? "" })),
          failed: results
            .filter((r) => !r.ok)
            .map((r) => ({ pr: r.pr, message: r.message ?? "Posting the comment failed." })),
        };
      },
      "ack-fyi": async ({ pr }) => {
        needRepo();
        await source.ackFyi(pr);
        return {};
      },
      refresh: async () => {
        await source.refresh();
        return {};
      },
      "list-repos": async () => ({ account: await needMe(), repos: await source.listRepos() }),
      "pick-repo": async ({ repo }) => {
        await source.pickRepo(repo);
        return { setup: await source.setup() };
      },
      "check-setup": async () => {
        needRepo();
        return { setup: await source.setup() };
      },
      "open-setup-pr": async () => {
        needRepo();
        const status = signer.status();
        return {
          pr: await source.openSetupPr(status.state === "no-key" ? null : status.key.publicKey),
        };
      },
      "create-key": async ({ passphrase, path }) => {
        const key = await signer.createKey(passphrase, path);
        source.keyCreated(key.publicKey);
        this.pushSigner();
        return { key: this.keyInfo(key) };
      },
      "open-enrol-pr": async () => {
        needRepo();
        const status = needKey();
        return { pr: await source.openEnrolPr(status.key.publicKey) };
      },
      "test-signature": async () => {
        const status = needKey();
        if (status.state !== "unlocked")
          throw new RequestFailure("locked", "Unlock the key first.");
        const me = await this.me();
        // Deliberately not a nod payload: it can never count on a PR.
        const line = `nod test signature · ${me?.login ?? "unknown"} · ${new Date(clock.now()).toISOString()}`;
        const signature = await signer.sign(line);
        return {
          payload: line,
          signature,
          verified: await signer.verify(line, signature),
          enrolment: source.enrolment(status.key.publicKey),
        };
      },
    };
  }
}

// ---------------------------------------------------------------------------
// parsing requests: nothing reaches a handler unchecked

const fail = (message: string): never => {
  throw new RequestFailure("bad-request", message);
};

type Json = Record<string, unknown>;

const isInt = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v > 0;
const str = (m: Json, key: string, optional = false): string | undefined => {
  const v = m[key];
  if (v === undefined && optional) return undefined;
  return typeof v === "string" ? v : fail(`${key} must be a string`);
};

function requestId(data: string): string | null {
  try {
    const m = JSON.parse(data) as Json;
    return typeof m?.id === "string" ? m.id : null;
  } catch {
    return null;
  }
}

function requestType(data: string): RequestType | null {
  try {
    const t = (JSON.parse(data) as Json)?.t;
    return typeof t === "string" && t in REQUEST_TYPES ? (t as RequestType) : null;
  } catch {
    return null;
  }
}

const REQUEST_TYPES: Record<RequestType, true> = {
  unlock: true,
  lock: true,
  sign: true,
  "ack-fyi": true,
  refresh: true,
  "list-repos": true,
  "pick-repo": true,
  "check-setup": true,
  "open-setup-pr": true,
  "create-key": true,
  "open-enrol-pr": true,
  "test-signature": true,
};

/** Parse and check one request; throws `RequestFailure` `bad-request`. */
export function parseRequest(data: string): ClientToServer {
  let m: Json;
  try {
    m = JSON.parse(data) as Json;
  } catch {
    return fail("not JSON");
  }
  if (typeof m !== "object" || m === null || Array.isArray(m)) return fail("not an object");
  const id = str(m, "id")!;
  if (id.length === 0 || id.length > 100) fail("bad id");
  const t = m.t;
  if (typeof t !== "string" || !(t in REQUEST_TYPES))
    return fail(`unknown request type ${String(t)}`);
  switch (t as RequestType) {
    case "unlock": {
      const passphrase = str(m, "passphrase")!;
      const minutes = m.minutes;
      if (minutes !== undefined && (typeof minutes !== "number" || !Number.isFinite(minutes)))
        fail("minutes must be a number");
      if (m.once !== undefined && typeof m.once !== "boolean") fail("once must be a boolean");
      return {
        t: "unlock",
        id,
        passphrase,
        ...(minutes !== undefined && { minutes: minutes as number }),
        ...(m.once !== undefined && { once: m.once as boolean }),
      };
    }
    case "sign": {
      if (!Array.isArray(m.entries) || m.entries.length === 0)
        return fail("entries must be a non-empty list");
      if (m.entries.length > MAX_BATCH) fail(`at most ${MAX_BATCH} PRs per nod`);
      const entries: SignEntry[] = m.entries.map((e: unknown) => {
        const entry = (typeof e === "object" && e !== null ? e : {}) as Json;
        if (!isInt(entry.pr)) fail("each entry needs a pr number");
        if (typeof entry.head_sha !== "string" || !/^[0-9a-f]{7,64}$/.test(entry.head_sha))
          fail("each entry needs a head_sha");
        return { pr: entry.pr as number, head_sha: entry.head_sha as string };
      });
      if (new Set(entries.map((e) => e.pr)).size !== entries.length) fail("a PR is listed twice");
      if (m.verdict !== "approve") fail("verdict must be approve");
      const note = str(m, "note", true);
      return { t: "sign", id, entries, verdict: "approve", ...(note !== undefined && { note }) };
    }
    case "ack-fyi":
      if (!isInt(m.pr)) fail("pr must be a number");
      return { t: "ack-fyi", id, pr: m.pr as number };
    case "pick-repo":
      return { t: "pick-repo", id, repo: str(m, "repo")! };
    case "create-key": {
      const passphrase = str(m, "passphrase")!;
      const path = str(m, "path", true);
      return { t: "create-key", id, passphrase, ...(path !== undefined && { path }) };
    }
    case "lock":
    case "refresh":
    case "list-repos":
    case "check-setup":
    case "open-setup-pr":
    case "open-enrol-pr":
    case "test-signature":
      return { t: t as "lock", id };
  }
}

function toRequestError(error: unknown): RequestError {
  if (error instanceof RequestFailure)
    return {
      code: error.code,
      message: error.message,
      ...(error.details && { details: error.details }),
    };
  if (error instanceof SignerError || error instanceof SourceError)
    return { code: error.code, message: error.message };
  // Not the error's text: it could carry anything. The server's log has it.
  console.error("nod serve: request failed:", error instanceof Error ? error.stack : error);
  return {
    code: "internal",
    message: "Something went wrong in nod serve; its log has the details.",
  };
}

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
import { SignerError, type Side, type Signer, type SignerKey } from "./signer";
import { SourceError, type NodPayload, type SignTarget, type Source } from "./source";
import { sameLogin } from "./view";

/**
 * One open tab. `send` takes the serialised message. `side` is where it is
 * connected from (`server.ts` decides it from the Host and the token): its
 * unlock window, and the lock state it is shown (ADR 0005).
 */
export interface Client {
  readonly side: Side;
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

/** The most PRs one nod (or one batch of approvals) may cover. */
export const MAX_BATCH = 100;

type Handlers = {
  [K in RequestType]: (
    message: Extract<ClientToServer, { t: K }>,
    client: Client,
  ) => Promise<RequestResult<K>>;
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
    const welcome = await this.welcome(client.side);
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
      const handler = this.handlers[message.t] as (
        m: ClientToServer,
        c: Client,
      ) => Promise<unknown>;
      const result = await handler(message, client);
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

  /** Every tab hears its own side's lock state. */
  private pushSigner() {
    const states = new Map<Side, string>();
    for (const client of this.clients) {
      let data = states.get(client.side);
      if (data === undefined) {
        data = JSON.stringify({
          t: "signer",
          signer: this.signerState(client.side),
        } satisfies ServerToClient);
        states.set(client.side, data);
      }
      client.send(data);
    }
  }

  private async me(): Promise<Account | null> {
    if (this.account === undefined) this.account = await this.options.source.account();
    return this.account;
  }

  private async welcome(side: Side): Promise<Welcome> {
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
      signer: this.signerState(side),
    };
  }

  /** The signer's state on `side`, with the enrolment the repo decides. */
  signerState(side: Side): SignerState {
    const status = this.options.signer.status(side);
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
    /**
     * Each entry's PR as it is now, all or nothing: a PR that is gone or not
     * open fails the request; one whose head moved since the user looked
     * makes it `stale`, listing every such entry, and nothing is done.
     */
    const atHeads = async (
      repo: string,
      entries: ReadonlyArray<SignEntry>,
      verb: "nodded" | "approved",
      done: "signed" | "approved",
    ): Promise<SignTarget[]> => {
      const stale: { pr: number; signed: string; current: string }[] = [];
      const targets: SignTarget[] = [];
      for (const entry of entries) {
        const target = await source.signTarget(entry.pr);
        if (!target) throw new RequestFailure("not-found", `#${entry.pr} is not in ${repo}.`);
        if (target.state !== "open")
          throw new RequestFailure(
            "not-open",
            `#${entry.pr} is ${target.state === "draft" ? "a draft" : target.state}; only open PRs can be ${verb}.`,
          );
        if (target.headSha !== entry.head_sha) {
          stale.push({ pr: entry.pr, signed: entry.head_sha, current: target.headSha });
          continue;
        }
        targets.push(target);
      }
      if (stale.length)
        throw new RequestFailure(
          "stale",
          `${stale.map((s) => `#${s.pr}`).join(", ")} changed since you looked. Nothing was ${done}.`,
          { stale },
        );
      return targets;
    };
    const needKey = (side: Side = "loopback") => {
      const status = signer.status(side);
      if (status.state === "no-key")
        throw new RequestFailure("no-key", "There is no signing key yet.");
      return status;
    };

    return {
      unlock: async ({ passphrase, minutes, once }, { side }) => {
        await signer.unlock(passphrase, {
          side,
          ...(minutes !== undefined && { minutes }),
          ...(once !== undefined && { once }),
        });
        const status = signer.status(side);
        return { until: status.state === "unlocked" ? status.until : clock.now() };
      },
      lock: async (_, { side }) => {
        signer.lock(side);
        return {};
      },
      sign: async ({ entries, verdict, note }, { side }) => {
        const repo = needRepo();
        const me = await needMe();
        const status = needKey(side);
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

        const targets = await atHeads(repo, entries, "nodded", "signed");
        const built: NodPayload["entries"][number][] = targets.map((target) => {
          if (!target.patchId)
            throw new RequestFailure(
              "no-patch-id",
              `The patch-id of #${target.pr} is not known yet; try again in a moment.`,
            );
          return {
            pr: target.pr,
            base: target.base,
            head_sha: target.headSha,
            patch_id: target.patchId,
          };
        });

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
        const signature = await signer.sign(line, side);
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
      approve: async ({ entries, note }) => {
        const repo = needRepo();
        const me = await needMe();
        const targets = await atHeads(repo, entries, "approved", "approved");
        const own = targets.find((t) => sameLogin(t.author, me.login));
        if (own)
          throw new RequestFailure(
            "forbidden",
            `#${own.pr} is your own pull request; GitHub does not let you approve it. Nothing was approved.`,
          );
        const results = await source.postApprovals({
          repo,
          entries: targets.map((t) => ({ pr: t.pr, headSha: t.headSha })),
          body: note?.trim() ? note.trim() : null,
        });
        return {
          posted: results.filter((r) => r.ok).map((r) => ({ pr: r.pr, url: r.url ?? "" })),
          failed: results
            .filter((r) => !r.ok)
            .map((r) => ({ pr: r.pr, message: r.message ?? "Approving failed." })),
        };
      },
      "ack-fyi": async ({ pr }) => {
        needRepo();
        await source.ackFyi(pr);
        return {};
      },
      ping: async () => ({}),
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
      "test-signature": async (_, { side }) => {
        const status = needKey(side);
        if (status.state !== "unlocked")
          throw new RequestFailure("locked", "Unlock the key first.");
        const me = await this.me();
        // Deliberately not a nod payload: it can never count on a PR.
        const line = `nod test signature · ${me?.login ?? "unknown"} · ${new Date(clock.now()).toISOString()}`;
        const signature = await signer.sign(line, side);
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
  approve: true,
  "ack-fyi": true,
  ping: true,
  refresh: true,
  "list-repos": true,
  "pick-repo": true,
  "check-setup": true,
  "open-setup-pr": true,
  "create-key": true,
  "open-enrol-pr": true,
  "test-signature": true,
};

/** A batch's entries: 1 to MAX_BATCH distinct PRs, each at a hex head SHA. */
function parseEntries(m: Json, what: string): SignEntry[] {
  if (!Array.isArray(m.entries) || m.entries.length === 0)
    return fail("entries must be a non-empty list");
  if (m.entries.length > MAX_BATCH) fail(`at most ${MAX_BATCH} PRs per ${what}`);
  const entries: SignEntry[] = m.entries.map((e: unknown) => {
    const entry = (typeof e === "object" && e !== null ? e : {}) as Json;
    if (!isInt(entry.pr)) fail("each entry needs a pr number");
    if (typeof entry.head_sha !== "string" || !/^[0-9a-f]{7,64}$/.test(entry.head_sha))
      fail("each entry needs a head_sha");
    return { pr: entry.pr as number, head_sha: entry.head_sha as string };
  });
  if (new Set(entries.map((e) => e.pr)).size !== entries.length) fail("a PR is listed twice");
  return entries;
}

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
      const entries = parseEntries(m, "nod");
      if (m.verdict !== "approve") fail("verdict must be approve");
      const note = str(m, "note", true);
      return { t: "sign", id, entries, verdict: "approve", ...(note !== undefined && { note }) };
    }
    case "approve": {
      const entries = parseEntries(m, "batch");
      const note = str(m, "note", true);
      return { t: "approve", id, entries, ...(note !== undefined && { note }) };
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
    case "ping":
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

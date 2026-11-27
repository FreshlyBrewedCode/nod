/**
 * The page's link to `nod serve`: pairing, the socket, typed requests.
 *
 * Pairing. `nod serve` prints `<web app>/#host=<ws url>&token=<token>`. The
 * page takes both from the fragment (browsers never send it to the web
 * host), keeps them in this origin's localStorage, and drops them from the
 * address bar, leaving any other fragment (a deep link) in place; a deep
 * link opened before pairing is remembered and taken up by the host link
 * (`rememberLink`, `takeLink`). Later
 * visits, bookmarks and deep links without a token use the stored pairing;
 * the token is stable across server restarts, so they keep working.
 *
 * The socket reconnects with backoff (0.5 s doubling to 10 s). Every
 * (re)connect brings a fresh `welcome` and `snapshot`, so nothing is
 * replayed. A token the server refuses (close code 4401) stops the retries:
 * the page has to be paired again.
 *
 * A tab that wakes (a phone unlocked, the network back) checks the socket
 * instead of trusting it: `wake()` sends a `ping` with a short timeout and
 * replaces a socket that does not answer, with the backoff reset. A socket
 * waiting in backoff connects at once. One check at a time.
 */

import {
  CLOSE_BAD_TOKEN,
  DEFAULT_SERVE_PORT,
  PROTOCOL_VERSION,
  WS_PATH,
  type ErrorCode,
  type InboxStatus,
  type InsightState,
  type RepoKey,
  type RequestBody,
  type RequestError,
  type RequestResult,
  type RequestType,
  type AppState,
  type RepoInfo,
  type ServerToClient,
  type SignerState,
  type Snapshot,
  type Welcome,
} from "../../shared/protocol";
import { sameRepo } from "../../shared/repo-key";
import { STABLE_WEB_URL } from "../../server/web-url";
import { fragmentOf } from "./route";

// ---------------------------------------------------------------------------
// pairing

export interface Pairing {
  /** `ws://127.0.0.1:4518` */
  readonly host: string;
  readonly token: string;
}

export const PAIRING_KEY = "nod.pairing";
export const DEFAULT_HOST = `ws://127.0.0.1:${DEFAULT_SERVE_PORT}`;

/** Where the page itself was loaded from (`location`'s `protocol` and `host`). */
export interface PageOrigin {
  readonly protocol: string;
  readonly host: string;
}

const LOOPBACK = ["127.0.0.1", "localhost", "[::1]"];

/** Loopback: `ws://` or `wss://` to `127.0.0.1`, `localhost` or `[::1]`. */
export function isLoopbackHost(host: string): boolean {
  try {
    const url = new URL(host);
    return (url.protocol === "ws:" || url.protocol === "wss:") && LOOPBACK.includes(url.hostname);
  } catch {
    return false;
  }
}

/**
 * Whether this page may pair with loopback: the hosted UI (both channels
 * share its origin), or a page on this machine (the dev server, a
 * preview). Any other page, above all the named host's on a phone, where
 * loopback is the phone itself, pairs only with its own host. No page (a
 * test, a script) is not a browser's and may. The same pages forward deep
 * links to a named host (`lib/forward.ts`).
 */
export function pairsWithLoopback(page: PageOrigin | null): boolean {
  if (!page) return true;
  const origin = URL.parse(`${page.protocol}//${page.host}`);
  return (
    !!origin &&
    (origin.origin === new URL(STABLE_WEB_URL).origin || LOOPBACK.includes(origin.hostname))
  );
}

/**
 * The servers a link may point this page at: loopback, from the pages that
 * may (`pairsWithLoopback`), or the very host that served the page over
 * https, as `wss://` (`nod serve --allow-host` serves the web app behind a
 * TLS proxy, ADR 0005). So a link cannot point the page at another
 * machine, the named host's page cannot be pointed at the phone's own
 * loopback, and plain `ws://` stays loopback.
 */
export function isAllowedHost(host: string, page: PageOrigin | null = null): boolean {
  if (isLoopbackHost(host)) return pairsWithLoopback(page);
  if (!page || page.protocol !== "https:") return false;
  try {
    const url = new URL(host);
    return url.protocol === "wss:" && url.host === page.host && url.pathname === "/";
  } catch {
    return false;
  }
}

/**
 * The pairing in a fragment, and the fragment without it. A token without a
 * host means the default port. The fragment is `host=…&token=…` as `nod
 * serve` prints it, or a route followed by them,
 * `/pr/<owner>/<repo>/<n>?host=…&token=…` (`lib/route.ts`); `rest` keeps
 * the route.
 */
export function readHostLink(
  hash: string,
  page: PageOrigin | null = null,
): { pairing: Pairing | null; rest: string } {
  const { path, params: query } = fragmentOf(hash);
  const params = new URLSearchParams(query);
  const token = params.get("token");
  const host = params.get("host") ?? DEFAULT_HOST;
  params.delete("token");
  params.delete("host");
  const left = params.toString();
  const rest = path ? `${path}${left ? `?${left}` : ""}` : left;
  if (!token || !isAllowedHost(host, page)) return { pairing: null, rest };
  return { pairing: { host: host.replace(/\/+$/, ""), token }, rest };
}

/**
 * A host link pasted into the page (a home-screen app has no address bar):
 * its fragment, when it is a link to this very page and pairs it, else null.
 * A link for another origin is refused even when its pairing would be
 * allowed: it was made for another page.
 */
export function pastedHostLink(text: string, page: PageOrigin): string | null {
  const url = URL.parse(text.trim());
  if (!url || url.origin !== `${page.protocol}//${page.host}`) return null;
  return readHostLink(url.hash, page).pairing ? url.hash : null;
}

/** What `localStorage` offers; injectable for tests. */
export interface KeyValue {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** The stored pairing; one this page may not use (it may have been stored by an older one) is dropped. */
export function loadPairing(storage: KeyValue, page: PageOrigin | null = null): Pairing | null {
  try {
    const value = JSON.parse(storage.getItem(PAIRING_KEY) ?? "null") as Partial<Pairing> | null;
    if (!value) return null;
    if (
      typeof value.host === "string" &&
      typeof value.token === "string" &&
      isAllowedHost(value.host, page)
    )
      return { host: value.host, token: value.token };
    storage.removeItem(PAIRING_KEY);
  } catch {
    // a broken entry is no pairing
  }
  return null;
}

export function savePairing(storage: KeyValue, pairing: Pairing): void {
  storage.setItem(PAIRING_KEY, JSON.stringify(pairing));
}

export function forgetPairing(storage: KeyValue): void {
  storage.removeItem(PAIRING_KEY);
}

// ---------------------------------------------------------------------------
// a deep link opened before pairing

/**
 * A deep link opened in a browser that is not paired yet (the hosted page,
 * from a GitHub comment) is remembered here, so the host link that pairs the
 * origin a minute later lands on the PR the user came for.
 */
export const PENDING_LINK_KEY = "nod.pendingLink";
/** How long a remembered link waits for the pairing. */
export const PENDING_LINK_MS = 60 * 60 * 1000;

/** Remember a deep link's fragment (`#/pr/…`) until the pairing. */
export function rememberLink(storage: KeyValue, hash: string, now: number): void {
  const { path } = fragmentOf(hash);
  if (!path) return;
  try {
    storage.setItem(PENDING_LINK_KEY, JSON.stringify({ hash: `#${path}`, at: now }));
  } catch {
    // blocked storage: the link is simply not kept
  }
}

/** The remembered deep link, if it is recent; taking it forgets it. */
export function takeLink(storage: KeyValue, now: number): string | null {
  let value: { hash?: unknown; at?: unknown } | null;
  try {
    value = JSON.parse(storage.getItem(PENDING_LINK_KEY) ?? "null") as {
      hash?: unknown;
      at?: unknown;
    } | null;
    storage.removeItem(PENDING_LINK_KEY);
  } catch {
    return null;
  }
  if (
    !value ||
    typeof value.hash !== "string" ||
    typeof value.at !== "number" ||
    now - value.at > PENDING_LINK_MS ||
    value.at > now + 60_000 ||
    !fragmentOf(value.hash).path
  )
    return null;
  return value.hash;
}

/**
 * The page's pairing: a fresh one from the address bar (stored, and removed
 * from the address bar), else the stored one. A fresh host link without a
 * route of its own continues to the deep link remembered before pairing.
 */
export function takePairing(
  location: Pick<Location, "hash" | "pathname" | "search"> &
    Partial<Pick<Location, "protocol" | "host">>,
  history: Pick<History, "replaceState">,
  storage: KeyValue,
  now: number = Date.now(),
): Pairing | null {
  const page = location.protocol && location.host ? (location as PageOrigin) : null;
  const { pairing, rest } = readHostLink(location.hash, page);
  if (pairing) {
    savePairing(storage, pairing);
    // Taken either way: a remembered link is used once, or not at all.
    const pending = takeLink(storage, now);
    const fragment = fragmentOf(rest).path ? `#${rest}` : (pending ?? (rest ? `#${rest}` : ""));
    history.replaceState(null, "", `${location.pathname}${location.search}${fragment}`);
    return pairing;
  }
  return loadPairing(storage, page);
}

/** The same repos, in any order (a reconnect to the same server keeps its last snapshot). */
function sameKeys(a: ReadonlyArray<RepoInfo> | null, b: ReadonlyArray<RepoInfo>): boolean {
  if (!a || a.length !== b.length) return false;
  const keys = new Set(a.map((r) => r.key.toLowerCase()));
  return b.every((r) => keys.has(r.key.toLowerCase()));
}

export function socketUrl(pairing: Pairing): string {
  return `${pairing.host}${WS_PATH}?token=${encodeURIComponent(pairing.token)}`;
}

// ---------------------------------------------------------------------------
// the client

/**
 * `unpaired`: no token yet (open the link `nod serve` printed). `refused`:
 * the server does not take this token (pair again). `outdated`: the server
 * speaks another protocol version.
 */
export type Status = "unpaired" | "connecting" | "open" | "closed" | "refused" | "outdated";

export interface ConnectionState {
  readonly status: Status;
  readonly welcome: Welcome | null;
  readonly snapshot: Snapshot | null;
  readonly signer: SignerState | null;
  /** The repos it reads, with their setup and my enrolment (ADR 0007); from the welcome and `repos` pushes. */
  readonly repos: ReadonlyArray<RepoInfo> | null;
  /** The app: version, channel, updates, the service (ADR 0008); null from a server without it. */
  readonly app: AppState | null;
  /** The last error the server pushed on its own (a failed poll, …). */
  readonly lastError: { readonly code: ErrorCode; readonly message: string } | null;
  /** How many times the socket closed since the page loaded. */
  readonly reconnects: number;
  /** My own inbox's status (ADR 0009); from the welcome and `inbox` pushes. null: none. */
  readonly inbox: InboxStatus | null;
}

export const INITIAL_STATE: ConnectionState = {
  status: "connecting",
  welcome: null,
  snapshot: null,
  signer: null,
  repos: null,
  app: null,
  lastError: null,
  reconnects: 0,
  inbox: null,
};

/**
 * An `insights` push (ADR 0009): one PR's insights replace those the
 * snapshot has, until the next snapshot. A PR the snapshot does not have is
 * left out; the same snapshot comes back when nothing changes.
 */
export function withInsights(
  snapshot: Snapshot | null,
  repo: RepoKey,
  pr: number,
  insights: ReadonlyArray<InsightState>,
): Snapshot | null {
  if (!snapshot) return snapshot;
  const i = snapshot.prs.findIndex((p) => p.number === pr && sameRepo(p.repo, repo));
  if (i < 0) return snapshot;
  const prs = [...snapshot.prs];
  prs[i] = { ...prs[i]!, insights };
  return { ...snapshot, prs };
}

/** A request the server answered with an error, or that never reached it. */
export class RequestFailed extends Error {
  constructor(
    readonly code: ErrorCode | "offline" | "timeout",
    message: string,
    readonly details?: RequestError["details"],
    /**
     * The request went out and no reply says what became of it (the socket
     * dropped, or the answer never came), so the server may have done it.
     * A request that was never sent, or got an error reply, is not uncertain.
     */
    readonly uncertain: boolean = false,
  ) {
    super(message);
  }
}

/** Timers and the clock, injectable so tests need no real time. */
export interface Scheduler {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

const REAL_TIME: Scheduler = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** What tells the page it woke: the window's events and the document's visibility. */
export interface WakeEnv {
  readonly win: EventTarget;
  readonly doc: EventTarget & { readonly visibilityState: string };
}

/** The page's own window and document, or null where there are none (tests, scripts). */
export function browserWakeEnv(): WakeEnv | null {
  return typeof window === "undefined" || typeof document === "undefined"
    ? null
    : { win: window, doc: document };
}

/**
 * Call `wake` when the page becomes visible, is restored from the
 * back/forward cache (`pageshow` with `persisted`), or the browser goes
 * online. Returns the way to stop listening.
 */
export function onWake(env: WakeEnv, wake: () => void): () => void {
  const visible = () => {
    if (env.doc.visibilityState === "visible") wake();
  };
  const shown = (event: Event) => {
    if ((event as Event & { persisted?: boolean }).persisted) wake();
  };
  env.doc.addEventListener("visibilitychange", visible);
  env.win.addEventListener("pageshow", shown);
  env.win.addEventListener("online", wake);
  return () => {
    env.doc.removeEventListener("visibilitychange", visible);
    env.win.removeEventListener("pageshow", shown);
    env.win.removeEventListener("online", wake);
  };
}

export interface ClientOptions {
  readonly WebSocket?: typeof WebSocket;
  /** A request without a reply fails after this long (signing posts comments: generous). */
  readonly timeoutMs?: number;
  readonly maxBackoffMs?: number;
  /** How long the wake check waits for its `ping` before it drops the socket. */
  readonly wakeCheckMs?: number;
  /** Where wake events come from; `null` listens to nothing. Default: the page's own. */
  readonly wakeEnv?: WakeEnv | null;
  readonly scheduler?: Scheduler;
}

type Pending = {
  resolve: (result: unknown) => void;
  reject: (error: RequestFailed) => void;
  timer: unknown;
};

export class NodClient {
  private ws: WebSocket | null = null;
  private retry = 0;
  private retryTimer: unknown = null;
  private stopped = false;
  /** A wake check is waiting for its ping: no second one meanwhile. */
  private checking = false;
  private connectingSince = 0;
  private readonly stopWake: () => void;
  private nextId = 0;
  private readonly pending = new Map<string, Pending>();
  private readonly listeners = new Set<() => void>();
  private readonly Socket: typeof WebSocket;
  private readonly timeoutMs: number;
  private readonly maxBackoffMs: number;
  private readonly wakeCheckMs: number;
  private readonly time: Scheduler;
  state: ConnectionState = INITIAL_STATE;

  constructor(
    private readonly url: string,
    options: ClientOptions = {},
  ) {
    this.Socket = options.WebSocket ?? WebSocket;
    this.timeoutMs = options.timeoutMs ?? 60_000;
    this.maxBackoffMs = options.maxBackoffMs ?? 10_000;
    this.wakeCheckMs = options.wakeCheckMs ?? 3_000;
    this.time = options.scheduler ?? REAL_TIME;
    const env = options.wakeEnv === undefined ? browserWakeEnv() : options.wakeEnv;
    this.stopWake = env ? onWake(env, () => this.wake()) : () => {};
    this.connect();
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Send a request; resolves with its typed result, rejects with `RequestFailed`. */
  request<K extends RequestType>(
    t: K,
    body: RequestBody<K>,
    options: { readonly timeoutMs?: number } = {},
  ): Promise<RequestResult<K>> {
    const ws = this.ws;
    if (!ws || ws.readyState !== this.Socket.OPEN || this.state.status !== "open")
      return Promise.reject(new RequestFailed("offline", "Not connected to nod serve."));
    const id = `r${++this.nextId}`;
    return new Promise<RequestResult<K>>((resolve, reject) => {
      const timer = this.time.setTimeout(() => {
        this.pending.delete(id);
        reject(new RequestFailed("timeout", "nod serve did not answer in time.", undefined, true));
      }, options.timeoutMs ?? this.timeoutMs);
      this.pending.set(id, { resolve: resolve as (r: unknown) => void, reject, timer });
      ws.send(JSON.stringify({ ...body, t, id }));
    });
  }

  /**
   * The page woke (or the network came back): do not trust the socket.
   * Open: a `ping` with a short timeout, and a socket that does not answer
   * is replaced at once. Any reply proves the socket lives, an error reply
   * from an older server that does not know `ping` included. Closed and
   * waiting in backoff: connect now. Connecting for longer than the check
   * takes: start over. Not while a check is running, and not for a token
   * the server refused or a protocol it does not speak.
   */
  wake(): void {
    if (this.stopped || this.checking) return;
    const { status } = this.state;
    if (status === "refused" || status === "outdated") return;
    const ws = this.ws;
    if (status === "closed") return this.replace(null);
    if (status === "connecting") {
      if (ws && this.time.now() - this.connectingSince >= this.wakeCheckMs) this.replace(ws);
      return;
    }
    this.checking = true;
    this.request("ping", {}, { timeoutMs: this.wakeCheckMs })
      .then(
        () => {},
        (error: unknown) => {
          if (error instanceof RequestFailed && error.code === "timeout" && this.ws === ws)
            this.replace(ws);
        },
      )
      .finally(() => {
        this.checking = false;
      });
  }

  /** Drop `ws` (it is not heard from again) and connect now, with the backoff reset. */
  private replace(ws: WebSocket | null) {
    if (ws) {
      this.ws = null;
      ws.onmessage = ws.onclose = null;
      try {
        ws.close();
      } catch {
        // already gone
      }
      this.failPending();
      this.set({ reconnects: this.state.reconnects + 1 });
    }
    if (this.retryTimer) this.time.clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.retry = 0;
    this.connect();
  }

  /** Stop for good (the page is closing, or pairing changed). */
  close(): void {
    this.stopped = true;
    this.stopWake();
    if (this.retryTimer) this.time.clearTimeout(this.retryTimer);
    this.ws?.close();
    this.failPending();
  }

  private set(patch: Partial<ConnectionState>) {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }

  private connect() {
    if (this.stopped) return;
    const ws = new this.Socket(this.url);
    this.ws = ws;
    this.connectingSince = this.time.now();
    this.set({ status: "connecting" });
    // "open" waits for the welcome: only then is it the server we expect.
    ws.onmessage = (event) => {
      if (this.ws === ws) this.receive(JSON.parse(String(event.data)) as ServerToClient);
    };
    ws.onclose = (event) => {
      if (this.ws !== ws) return;
      this.failPending();
      if (this.stopped) return this.set({ status: "closed" });
      if (event.code === CLOSE_BAD_TOKEN) return this.set({ status: "refused" });
      if (this.state.status === "outdated") return;
      this.set({ status: "closed", reconnects: this.state.reconnects + 1 });
      const delay = Math.min(this.maxBackoffMs, 500 * 2 ** this.retry++);
      this.retryTimer = this.time.setTimeout(() => this.connect(), delay);
    };
  }

  private receive(message: ServerToClient) {
    switch (message.t) {
      case "welcome":
        if (message.protocol !== PROTOCOL_VERSION) {
          this.set({ status: "outdated", welcome: message });
          this.ws?.close();
          return;
        }
        this.retry = 0;
        return this.set({
          status: "open",
          welcome: message,
          signer: message.signer,
          repos: message.repos,
          app: message.app ?? null,
          inbox: message.inbox ?? null,
          // A snapshot of other repos would be wrong; the next one follows.
          snapshot: sameKeys(this.state.repos, message.repos) ? this.state.snapshot : null,
        });
      case "snapshot": {
        const { t: _, ...snapshot } = message;
        return this.set({ snapshot });
      }
      case "signer":
        return this.set({ signer: message.signer });
      case "repos":
        return this.set({ repos: message.repos });
      case "app":
        return this.set({ app: message.app });
      case "inbox":
        return this.set({ inbox: message.inbox });
      case "insights":
        return this.set({
          snapshot: withInsights(this.state.snapshot, message.repo, message.pr, message.insights),
        });
      case "error":
        return this.set({ lastError: { code: message.code, message: message.message } });
      case "reply": {
        const pending = this.pending.get(message.id);
        if (!pending) return;
        this.pending.delete(message.id);
        this.time.clearTimeout(pending.timer);
        if (message.ok) pending.resolve(message.result);
        else
          pending.reject(
            new RequestFailed(message.error.code, message.error.message, message.error.details),
          );
        return;
      }
    }
  }

  private failPending() {
    for (const [id, p] of this.pending) {
      this.time.clearTimeout(p.timer);
      p.reject(
        new RequestFailed("offline", "The connection to nod serve closed.", undefined, true),
      );
      this.pending.delete(id);
    }
  }
}

/**
 * The page's link to `nod serve`: pairing, the socket, typed requests.
 *
 * Pairing. `nod serve` prints `<web app>/#host=<ws url>&token=<token>`. The
 * page takes both from the fragment (browsers never send it to the web
 * host), keeps them in this origin's localStorage, and drops them from the
 * address bar, leaving any other fragment (a deep link) in place. Later
 * visits, bookmarks and deep links without a token use the stored pairing;
 * the token is stable across server restarts, so they keep working.
 *
 * The socket reconnects with backoff (0.5 s doubling to 10 s). Every
 * (re)connect brings a fresh `welcome` and `snapshot`, so nothing is
 * replayed. A token the server refuses (close code 4401) stops the retries:
 * the page has to be paired again.
 */

import {
  CLOSE_BAD_TOKEN,
  DEFAULT_SERVE_PORT,
  PROTOCOL_VERSION,
  WS_PATH,
  type ErrorCode,
  type RequestBody,
  type RequestError,
  type RequestResult,
  type RequestType,
  type ServerToClient,
  type SetupStatus,
  type SignerState,
  type Snapshot,
  type Welcome,
} from "../../shared/protocol";

// ---------------------------------------------------------------------------
// pairing

export interface Pairing {
  /** `ws://127.0.0.1:4518` */
  readonly host: string;
  readonly token: string;
}

export const PAIRING_KEY = "nod.pairing";
export const DEFAULT_HOST = `ws://127.0.0.1:${DEFAULT_SERVE_PORT}`;

/** Only loopback: a link must not point this page at another machine. */
export function isLoopbackHost(host: string): boolean {
  try {
    const url = new URL(host);
    return (
      (url.protocol === "ws:" || url.protocol === "wss:") &&
      ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
    );
  } catch {
    return false;
  }
}

/**
 * The pairing in a fragment, and the fragment without it. A token without a
 * host means the default port.
 */
export function readHostLink(hash: string): { pairing: Pairing | null; rest: string } {
  const params = new URLSearchParams(hash.replace(/^#/, ""));
  const token = params.get("token");
  const host = params.get("host") ?? DEFAULT_HOST;
  params.delete("token");
  params.delete("host");
  const rest = params.toString();
  if (!token || !isLoopbackHost(host)) return { pairing: null, rest };
  return { pairing: { host: host.replace(/\/+$/, ""), token }, rest };
}

/** What `localStorage` offers; injectable for tests. */
export interface KeyValue {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export function loadPairing(storage: KeyValue): Pairing | null {
  try {
    const value = JSON.parse(storage.getItem(PAIRING_KEY) ?? "null") as Partial<Pairing> | null;
    if (
      value &&
      typeof value.host === "string" &&
      typeof value.token === "string" &&
      isLoopbackHost(value.host)
    )
      return { host: value.host, token: value.token };
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

/**
 * The page's pairing: a fresh one from the address bar (stored, and removed
 * from the address bar), else the stored one.
 */
export function takePairing(
  location: Pick<Location, "hash" | "pathname" | "search">,
  history: Pick<History, "replaceState">,
  storage: KeyValue,
): Pairing | null {
  const { pairing, rest } = readHostLink(location.hash);
  if (pairing) {
    savePairing(storage, pairing);
    history.replaceState(
      null,
      "",
      `${location.pathname}${location.search}${rest ? `#${rest}` : ""}`,
    );
    return pairing;
  }
  return loadPairing(storage);
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
  readonly setup: SetupStatus | null;
  /** The last error the server pushed on its own (a failed poll, …). */
  readonly lastError: { readonly code: ErrorCode; readonly message: string } | null;
  /** How many times the socket closed since the page loaded. */
  readonly reconnects: number;
}

export const INITIAL_STATE: ConnectionState = {
  status: "connecting",
  welcome: null,
  snapshot: null,
  signer: null,
  setup: null,
  lastError: null,
  reconnects: 0,
};

/** A request the server answered with an error, or that never reached it. */
export class RequestFailed extends Error {
  constructor(
    readonly code: ErrorCode | "offline" | "timeout",
    message: string,
    readonly details?: RequestError["details"],
  ) {
    super(message);
  }
}

export interface ClientOptions {
  readonly WebSocket?: typeof WebSocket;
  /** A request without a reply fails after this long (signing posts comments: generous). */
  readonly timeoutMs?: number;
  readonly maxBackoffMs?: number;
}

type Pending = {
  resolve: (result: unknown) => void;
  reject: (error: RequestFailed) => void;
  timer: ReturnType<typeof setTimeout>;
};

export class NodClient {
  private ws: WebSocket | null = null;
  private retry = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private nextId = 0;
  private readonly pending = new Map<string, Pending>();
  private readonly listeners = new Set<() => void>();
  private readonly Socket: typeof WebSocket;
  private readonly timeoutMs: number;
  private readonly maxBackoffMs: number;
  state: ConnectionState = INITIAL_STATE;

  constructor(
    private readonly url: string,
    options: ClientOptions = {},
  ) {
    this.Socket = options.WebSocket ?? WebSocket;
    this.timeoutMs = options.timeoutMs ?? 60_000;
    this.maxBackoffMs = options.maxBackoffMs ?? 10_000;
    this.connect();
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Send a request; resolves with its typed result, rejects with `RequestFailed`. */
  request<K extends RequestType>(t: K, body: RequestBody<K>): Promise<RequestResult<K>> {
    const ws = this.ws;
    if (!ws || ws.readyState !== this.Socket.OPEN || this.state.status !== "open")
      return Promise.reject(new RequestFailed("offline", "Not connected to nod serve."));
    const id = `r${++this.nextId}`;
    return new Promise<RequestResult<K>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new RequestFailed("timeout", "nod serve did not answer in time."));
      }, this.timeoutMs);
      this.pending.set(id, { resolve: resolve as (r: unknown) => void, reject, timer });
      ws.send(JSON.stringify({ ...body, t, id }));
    });
  }

  /** Stop for good (the page is closing, or pairing changed). */
  close(): void {
    this.stopped = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
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
    this.set({ status: "connecting" });
    // "open" waits for the welcome: only then is it the server we expect.
    ws.onmessage = (event) => this.receive(JSON.parse(String(event.data)) as ServerToClient);
    ws.onclose = (event) => {
      if (this.ws !== ws) return;
      this.failPending();
      if (this.stopped) return this.set({ status: "closed" });
      if (event.code === CLOSE_BAD_TOKEN) return this.set({ status: "refused" });
      if (this.state.status === "outdated") return;
      this.set({ status: "closed", reconnects: this.state.reconnects + 1 });
      const delay = Math.min(this.maxBackoffMs, 500 * 2 ** this.retry++);
      this.retryTimer = setTimeout(() => this.connect(), delay);
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
          setup: message.setup,
          // A snapshot of another repo would be wrong; the next one follows.
          snapshot: this.state.snapshot?.repo === message.repo ? this.state.snapshot : null,
        });
      case "snapshot": {
        const { t: _, ...snapshot } = message;
        return this.set({ snapshot });
      }
      case "signer":
        return this.set({ signer: message.signer });
      case "setup":
        return this.set({ setup: message.setup });
      case "error":
        return this.set({ lastError: { code: message.code, message: message.message } });
      case "reply": {
        const pending = this.pending.get(message.id);
        if (!pending) return;
        this.pending.delete(message.id);
        clearTimeout(pending.timer);
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
      clearTimeout(p.timer);
      p.reject(new RequestFailed("offline", "The connection to nod serve closed."));
      this.pending.delete(id);
    }
  }
}

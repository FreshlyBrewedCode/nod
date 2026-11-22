import { beforeEach, describe, expect, test } from "bun:test";

import { CLOSE_BAD_TOKEN, PROTOCOL_VERSION } from "../../shared/protocol";
import {
  NodClient,
  RequestFailed,
  onWake,
  type ClientOptions,
  type Scheduler,
  type WakeEnv,
} from "./connection";

/** A socket the test drives by hand; `close()` fires nothing, like a dead connection. */
class FakeSocket {
  static OPEN = 1;
  static instances: FakeSocket[] = [];
  readyState = 0;
  sent: Array<{ t: string; id: string }> = [];
  closedByClient = false;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  constructor(readonly url: string) {
    FakeSocket.instances.push(this);
  }
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  close() {
    this.closedByClient = true;
  }
  /** The server's welcome: the socket is open for the client. */
  welcome() {
    this.readyState = FakeSocket.OPEN;
    this.push({ t: "welcome", protocol: PROTOCOL_VERSION, repo: "acme/widgets", signer: null });
  }
  push(message: object) {
    this.onmessage?.({ data: JSON.stringify(message) });
  }
  reply(id: string, error?: { code: string; message: string }) {
    this.push(
      error ? { t: "reply", id, ok: false, error } : { t: "reply", id, ok: true, result: {} },
    );
  }
  /** The browser reports the close. */
  drop(code = 1006) {
    this.readyState = 3;
    this.onclose?.({ code });
  }
}

/** Time that moves only when the test says so. */
class ManualTime implements Scheduler {
  at = 0;
  private next = 0;
  private timers = new Map<number, { due: number; fn: () => void }>();
  now = () => this.at;
  setTimeout = (fn: () => void, ms: number) => {
    const id = ++this.next;
    this.timers.set(id, { due: this.at + ms, fn });
    return id;
  };
  clearTimeout = (handle: unknown) => void this.timers.delete(handle as number);
  get waiting() {
    return this.timers.size;
  }
  advance(ms: number) {
    const end = this.at + ms;
    for (;;) {
      const due = [...this.timers.entries()]
        .filter(([, t]) => t.due <= end)
        .sort((a, b) => a[1].due - b[1].due)[0];
      if (!due) break;
      this.timers.delete(due[0]);
      this.at = due[1].due;
      due[1].fn();
    }
    this.at = end;
  }
}

class FakeTarget extends EventTarget {
  visibilityState = "visible";
}

let time: ManualTime;
let win: EventTarget;
let doc: FakeTarget;

const sockets = () => FakeSocket.instances;
const lastSocket = () => FakeSocket.instances.at(-1)!;
/** Let promise callbacks run. */
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function start(options: ClientOptions = {}) {
  const client = new NodClient("ws://127.0.0.1:1/ws?token=t", {
    WebSocket: FakeSocket as unknown as typeof WebSocket,
    scheduler: time,
    wakeEnv: { win, doc } satisfies WakeEnv,
    ...options,
  });
  lastSocket().welcome();
  return client;
}
const pings = (socket: FakeSocket) => socket.sent.filter((m) => m.t === "ping");

beforeEach(() => {
  FakeSocket.instances = [];
  time = new ManualTime();
  win = new EventTarget();
  doc = new FakeTarget();
});

const becomeVisible = () => doc.dispatchEvent(new Event("visibilitychange"));

describe("the wake check", () => {
  test("visible while open and alive: one ping, answered, the socket stays", async () => {
    const client = start();
    const socket = lastSocket();
    becomeVisible();
    expect(pings(socket)).toHaveLength(1);
    socket.reply(pings(socket)[0]!.id);
    await settle();
    time.advance(10_000);
    expect(sockets()).toHaveLength(1);
    expect(socket.closedByClient).toBe(false);
    expect(client.state.status).toBe("open");
    expect(client.state.reconnects).toBe(0);
  });

  test("visible while half-open: no answer in 3 s drops the socket and connects at once", async () => {
    const client = start();
    const dead = lastSocket();
    becomeVisible();
    time.advance(2_999);
    expect(sockets()).toHaveLength(1);
    expect(client.state.status).toBe("open");
    time.advance(1);
    await settle();
    expect(dead.closedByClient).toBe(true);
    expect(sockets()).toHaveLength(2);
    expect(client.state).toMatchObject({ status: "connecting", reconnects: 1 });
    // the new socket is welcomed: open again, nothing waits on the backoff
    lastSocket().welcome();
    expect(client.state.status).toBe("open");
    expect(time.waiting).toBe(0);
  });

  test("a dropped socket says nothing more: its late messages and close are ignored", async () => {
    const client = start();
    const dead = lastSocket();
    becomeVisible();
    time.advance(3_000);
    await settle();
    lastSocket().welcome();
    dead.push({ t: "error", code: "internal", message: "late" });
    dead.drop();
    expect(client.state).toMatchObject({ status: "open", lastError: null, reconnects: 1 });
    expect(sockets()).toHaveLength(2);
    expect(time.waiting).toBe(0);
  });

  test("the backoff starts over after a wake: the next drop retries after 0.5 s, not 4 s", () => {
    const client = start();
    // a server that is down: drops without a welcome run the backoff up to 4 s
    lastSocket().drop();
    for (const wait of [500, 1_000, 2_000]) {
      time.advance(wait);
      lastSocket().drop();
    }
    expect(client.state.status).toBe("closed");
    becomeVisible();
    lastSocket().drop();
    const count = sockets().length;
    time.advance(499);
    expect(sockets()).toHaveLength(count);
    time.advance(1);
    expect(sockets()).toHaveLength(count + 1);
  });

  test("visible while the socket waits in backoff: connect at once", () => {
    const client = start();
    lastSocket().drop();
    expect(client.state.status).toBe("closed");
    expect(time.waiting).toBe(1);
    becomeVisible();
    expect(sockets()).toHaveLength(2);
    expect(client.state.status).toBe("connecting");
    // the backoff timer is gone: no third socket
    time.advance(60_000);
    expect(sockets()).toHaveLength(2);
  });

  test("`online` checks the same way", async () => {
    const client = start();
    const socket = lastSocket();
    win.dispatchEvent(new Event("online"));
    expect(pings(socket)).toHaveLength(1);
    time.advance(3_000);
    await settle();
    expect(sockets()).toHaveLength(2);
    expect(client.state.reconnects).toBe(1);
  });

  test("only a visible page, and a restored one, count", () => {
    start();
    const socket = lastSocket();
    doc.visibilityState = "hidden";
    becomeVisible();
    win.dispatchEvent(Object.assign(new Event("pageshow"), { persisted: false }));
    expect(pings(socket)).toHaveLength(0);
    win.dispatchEvent(Object.assign(new Event("pageshow"), { persisted: true }));
    expect(pings(socket)).toHaveLength(1);
  });

  test("two wake events in a row: one check", async () => {
    start();
    const socket = lastSocket();
    becomeVisible();
    win.dispatchEvent(new Event("online"));
    becomeVisible();
    expect(pings(socket)).toHaveLength(1);
    // once it is answered, the next wake checks again
    socket.reply(pings(socket)[0]!.id);
    await settle();
    becomeVisible();
    expect(pings(socket)).toHaveLength(2);
  });

  test("an older server that does not know `ping` still proves the socket lives", async () => {
    start();
    const socket = lastSocket();
    becomeVisible();
    socket.reply(pings(socket)[0]!.id, {
      code: "bad-request",
      message: "unknown request type ping",
    });
    await settle();
    time.advance(10_000);
    expect(sockets()).toHaveLength(1);
    expect(socket.closedByClient).toBe(false);
  });

  test("a socket that closes during the check is left to its close event", async () => {
    const client = start();
    const socket = lastSocket();
    becomeVisible();
    socket.drop();
    await settle();
    expect(client.state.status).toBe("closed");
    time.advance(500);
    expect(sockets()).toHaveLength(2);
    // not replaced twice
    time.advance(5_000);
    expect(sockets()).toHaveLength(2);
  });

  test("a connect that has hung since before the sleep starts over; a fresh one is left alone", () => {
    const client = new NodClient("ws://127.0.0.1:1/ws", {
      WebSocket: FakeSocket as unknown as typeof WebSocket,
      scheduler: time,
      wakeEnv: { win, doc },
    });
    time.advance(1_000);
    becomeVisible();
    expect(sockets()).toHaveLength(1);
    time.advance(2_000);
    becomeVisible();
    expect(sockets()).toHaveLength(2);
    expect(client.state.status).toBe("connecting");
  });

  test("a refused pairing is not retried by a wake", () => {
    const client = start();
    lastSocket().drop(CLOSE_BAD_TOKEN);
    expect(client.state.status).toBe("refused");
    becomeVisible();
    expect(sockets()).toHaveLength(1);
  });

  test("a stopped client listens to nothing", () => {
    const client = start();
    client.close();
    becomeVisible();
    win.dispatchEvent(new Event("online"));
    expect(pings(lastSocket())).toHaveLength(0);
    expect(sockets()).toHaveLength(1);
  });
});

describe("requests while the socket is not trustworthy", () => {
  test("not connected: fails at once, never queued, never sent", async () => {
    const client = start();
    const socket = lastSocket();
    socket.drop();
    const failure = await client.request("refresh", {}).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(RequestFailed);
    expect(failure).toMatchObject({ code: "offline", uncertain: false });
    // and nothing is sent when the socket comes back
    time.advance(500);
    lastSocket().welcome();
    expect(socket.sent.concat(lastSocket().sent)).toHaveLength(0);
  });

  test("dropped mid-request: failed as uncertain, since the server may have done it", async () => {
    const client = start();
    const socket = lastSocket();
    const sign = client.request("lock", {}).catch((e: unknown) => e);
    socket.drop();
    expect(await sign).toMatchObject({ code: "offline", uncertain: true });
  });

  test("replaced by the wake check mid-request: the same", async () => {
    const client = start();
    const sign = client.request("lock", {}).catch((e: unknown) => e);
    becomeVisible();
    time.advance(3_000);
    expect(await sign).toMatchObject({ code: "offline", uncertain: true });
  });

  test("no answer in time: uncertain too", async () => {
    const client = start({ timeoutMs: 5_000 });
    const sign = client.request("lock", {}).catch((e: unknown) => e);
    time.advance(5_000);
    expect(await sign).toMatchObject({ code: "timeout", uncertain: true });
  });

  test("an error reply is certain", async () => {
    const client = start();
    const socket = lastSocket();
    const sign = client.request("lock", {}).catch((e: unknown) => e);
    socket.reply(socket.sent[0]!.id, { code: "locked", message: "locked" });
    expect(await sign).toMatchObject({ code: "locked", uncertain: false });
  });
});

test("onWake listens to the three signals and lets go again", () => {
  let woke = 0;
  const off = onWake({ win, doc }, () => woke++);
  becomeVisible();
  win.dispatchEvent(new Event("online"));
  win.dispatchEvent(Object.assign(new Event("pageshow"), { persisted: true }));
  expect(woke).toBe(3);
  off();
  becomeVisible();
  win.dispatchEvent(new Event("online"));
  expect(woke).toBe(3);
});

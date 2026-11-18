import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CLOSE_BAD_TOKEN, CLOSE_SHUTDOWN, type ServerToClient } from "../shared/protocol";
import { NodClient, RequestFailed } from "../web/lib/connection";
import { ManualClock } from "./clock";
import { start, type Started } from "./start";
import { DEV_WEB_URL, NEXT_WEB_URL } from "./web-url";

const running: Started[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const s of running.splice(0)) await s.stop();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function startFake(clock = new ManualClock(Date.UTC(2026, 10, 18, 14, 20))) {
  const dir = mkdtempSync(join(tmpdir(), "nod-serve-"));
  dirs.push(dir);
  // Port 0: the OS picks a free one, so tests never collide with a running nod serve.
  const started = start({
    port: 0,
    webUrl: NEXT_WEB_URL,
    tokenFile: join(dir, "serve-token"),
    version: null,
    fake: { scenario: "team", live: false },
    clock,
  });
  running.push(started);
  const http = `http://127.0.0.1:${started.serving.port}`;
  return {
    started,
    http,
    clock,
    ws: (token: string | null) =>
      `${started.wsUrl}/ws${token === null ? "" : `?token=${encodeURIComponent(token)}`}`,
  };
}

/** Open a raw socket and collect what happens until it closes or `ms` pass. */
function probe(url: string, headers: Record<string, string> = {}, ms = 300) {
  return new Promise<{ messages: ServerToClient[]; code: number | null; opened: boolean }>(
    (resolve) => {
      const messages: ServerToClient[] = [];
      let opened = false;
      const ws = new WebSocket(url, { headers } as unknown as string[]);
      const timer = setTimeout(() => {
        ws.close();
        resolve({ messages, code: null, opened });
      }, ms);
      ws.onopen = () => (opened = true);
      ws.onmessage = (e) => messages.push(JSON.parse(String(e.data)) as ServerToClient);
      ws.onclose = (e) => {
        clearTimeout(timer);
        resolve({ messages, code: e.code, opened });
      };
    },
  );
}

const until = async (check: () => boolean, ms = 2000) => {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("timed out");
    await Bun.sleep(5);
  }
};

describe("http", () => {
  test("/health says what it is, with CORS only for allowed origins", async () => {
    const { http } = startFake();
    const plain = await fetch(`${http}/health`);
    expect(await plain.json()).toEqual({ ok: true, name: "nod", protocol: 1, version: null });
    expect(plain.headers.get("access-control-allow-origin")).toBeNull();
    const ours = await fetch(`${http}/health`, {
      headers: { Origin: "https://ui.nod.frebreco.de" },
    });
    expect(ours.headers.get("access-control-allow-origin")).toBe("https://ui.nod.frebreco.de");
    const theirs = await fetch(`${http}/health`, { headers: { Origin: "https://evil.example" } });
    expect(theirs.headers.get("access-control-allow-origin")).toBeNull();
  });

  test("the private-network preflight is answered for allowed origins only", async () => {
    const { http } = startFake();
    const preflight = (origin: string) =>
      fetch(`${http}/health`, {
        method: "OPTIONS",
        headers: {
          Origin: origin,
          "Access-Control-Request-Method": "GET",
          "Access-Control-Request-Private-Network": "true",
        },
      });
    const ours = await preflight("https://ui.nod.frebreco.de");
    expect(ours.status).toBe(204);
    expect(ours.headers.get("access-control-allow-private-network")).toBe("true");
    expect(ours.headers.get("access-control-allow-origin")).toBe("https://ui.nod.frebreco.de");
    const dev = await preflight("http://127.0.0.1:4517");
    expect(dev.status).toBe(204);
    const theirs = await preflight("https://evil.example");
    expect(theirs.status).toBe(403);
    expect(theirs.headers.get("access-control-allow-private-network")).toBeNull();
  });

  test("a request naming another host (DNS rebinding) is refused", async () => {
    const { http } = startFake();
    const res = await fetch(`${http}/health`, { headers: { Host: "evil.example:4518" } });
    expect(res.status).toBe(421);
    expect((await fetch(`${http}/nope`)).status).toBe(404);
  });
});

describe("the socket", () => {
  test("the right token: welcome, then the snapshot", async () => {
    const { started, ws } = startFake();
    const { messages } = await probe(ws(started.token), { Origin: DEV_WEB_URL });
    expect(messages.map((m) => m.t)).toEqual(["welcome", "snapshot"]);
    expect(messages[0]).toMatchObject({
      t: "welcome",
      me: { login: "mara-l" },
      repo: "tallyho/fieldbook",
    });
  });

  test("no token or a wrong one: closed with 4401, nothing sent", async () => {
    const { started, ws } = startFake();
    for (const url of [
      ws(null),
      ws("wrong"),
      ws(`${started.token}x`),
      ws(started.token.slice(0, -1)),
    ]) {
      const result = await probe(url, { Origin: DEV_WEB_URL });
      expect(result.code).toBe(CLOSE_BAD_TOKEN);
      expect(result.messages).toEqual([]);
    }
    expect(started.session.clientCount).toBe(0);
  });

  test("a page from another origin never gets a socket, even with the token", async () => {
    const { started, ws } = startFake();
    const result = await probe(ws(started.token), { Origin: "https://evil.example" });
    expect(result.opened).toBe(false);
    expect(result.messages).toEqual([]);
  });

  test("stopping the server closes the tabs with 4001", async () => {
    const { started, ws } = startFake();
    const pending = probe(ws(started.token), { Origin: DEV_WEB_URL }, 2000);
    await until(() => started.session.clientCount === 1);
    running.splice(running.indexOf(started), 1);
    await started.stop();
    expect((await pending).code).toBe(CLOSE_SHUTDOWN);
  });
});

describe("the web client against the fake", () => {
  test("unlock, sign, ack, auto-lock: the round trip through NodClient", async () => {
    const { started, ws, clock } = startFake();
    const client = new NodClient(ws(started.token));
    try {
      await until(() => client.state.status === "open" && client.state.snapshot !== null);
      expect(client.state.welcome?.me?.login).toBe("mara-l");
      expect(client.state.signer?.state).toBe("locked");

      const wrong = await client
        .request("unlock", { passphrase: "wrong" })
        .catch((e: unknown) => e);
      expect(wrong).toBeInstanceOf(RequestFailed);
      expect((wrong as RequestFailed).code).toBe("bad-passphrase");

      await client.request("unlock", { passphrase: "pass", minutes: 15 });
      await until(() => client.state.signer?.state === "unlocked");

      const pr = client.state.snapshot!.prs.find((p) => p.number === 482)!;
      const result = await client.request("sign", {
        entries: [{ pr: 482, head_sha: pr.headSha }],
        verdict: "approve",
      });
      expect(result.posted.map((p) => p.pr)).toEqual([482]);
      await until(
        () => client.state.snapshot!.prs.find((p) => p.number === 482)!.needsMe === false,
      );

      await client.request("ack-fyi", { pr: 478 });
      await until(
        () => client.state.snapshot!.prs.find((p) => p.number === 478)!.fyiForMe === false,
      );

      clock.advance(15 * 60_000);
      await until(() => client.state.signer?.state === "locked");
    } finally {
      client.close();
    }
  });

  test("a refused token stops the retries", async () => {
    const { ws } = startFake();
    const client = new NodClient(ws("wrong"));
    try {
      await until(() => client.state.status === "refused");
      await expect(client.request("refresh", {})).rejects.toBeInstanceOf(RequestFailed);
    } finally {
      client.close();
    }
  });

  test("it reconnects after the server comes back", async () => {
    const first = startFake();
    const port = first.started.serving.port;
    const client = new NodClient(first.ws(first.started.token), { maxBackoffMs: 50 });
    try {
      await until(() => client.state.status === "open");
      running.splice(running.indexOf(first.started), 1);
      await first.started.stop();
      await until(() => client.state.status !== "open");
      // the same port and token file: as if nod serve was restarted
      const again = start({
        port,
        webUrl: NEXT_WEB_URL,
        tokenFile: join(dirs.at(-1)!, "serve-token"),
        version: null,
        fake: { scenario: "team", live: false },
        clock: new ManualClock(0),
      });
      running.push(again);
      await until(() => client.state.status === "open" && client.state.reconnects >= 1, 5000);
      expect(again.token).toBe(first.started.token);
    } finally {
      client.close();
    }
  });
});

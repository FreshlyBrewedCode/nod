import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CLOSE_BAD_TOKEN, CLOSE_SHUTDOWN, type ServerToClient } from "../shared/protocol";
import { NodClient, RequestFailed } from "../web/lib/connection";
import { ManualClock } from "./clock";
import { parseNamedHost } from "../shared/named-host";
import { start, type StartOptions, type Started } from "./start";
import { DEV_WEB_URL, NEXT_WEB_URL } from "./web-url";

const running: Started[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const s of running.splice(0)) await s.stop();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function startFake(
  clock = new ManualClock(Date.UTC(2026, 10, 18, 14, 20)),
  extra: Pick<StartOptions, "namedHost" | "newToken" | "newRemoteToken" | "appRoot" | "app"> = {},
  tokenDir?: string,
) {
  const dir = tokenDir ?? mkdtempSync(join(tmpdir(), "nod-serve-"));
  if (!tokenDir) dirs.push(dir);
  // Port 0: the OS picks a free one, so tests never collide with a running nod serve.
  const started = start({
    port: 0,
    webUrl: NEXT_WEB_URL,
    tokenFile: join(dir, "serve-token"),
    version: null,
    fake: { scenario: "team", live: false },
    clock,
    // My inbox's pushes are its own tests' (`inbox/session-inbox.test.ts`).
    inbox: null,
    ...extra,
  });
  running.push(started);
  const http = `http://127.0.0.1:${started.serving.port}`;
  return {
    started,
    http,
    clock,
    dir,
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

/** One raw HTTP/1.1 request, for a Host that `fetch` would not send. */
async function rawGet(port: number, host: string): Promise<{ status: number; text: string }> {
  const { connect } = await import("node:net");
  return new Promise((resolve, reject) => {
    let data = "";
    const socket = connect(port, "127.0.0.1", () =>
      socket.write(`GET / HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`),
    );
    socket.on("data", (chunk) => (data += chunk.toString()));
    socket.on("error", reject);
    socket.on("close", () =>
      resolve({ status: Number(/^HTTP\/1\.1 (\d+)/.exec(data)?.[1] ?? 0), text: data }),
    );
  });
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
    expect(await plain.json()).toEqual({
      ok: true,
      name: "nod",
      protocol: 2,
      version: null,
      gh: { host: "github.com", state: "signed-in", detail: null },
    });
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

  test("a malformed Host gets a bare refusal, never an error page with paths", async () => {
    const { started } = startFake();
    for (const host of ["nod.example.test%zz", "[x", "127.0.0.1:47811,x", "127.0.0.1%zz"]) {
      const { status, text } = await rawGet(started.serving.port, host);
      expect([400, 421]).toContain(status);
      expect(text.length).toBeLessThan(400);
      expect(text).not.toContain("/src/");
    }
  });
});

describe("the app on loopback (ADR 0008)", () => {
  const appRoot = mkdtempSync(join(tmpdir(), "nod-app-"));
  writeFileSync(join(appRoot, "index.html"), "<!doctype html><title>nod app</title>");
  writeFileSync(join(appRoot, "sw.js"), "self.addEventListener('fetch', () => {});");
  afterAll(() => rmSync(appRoot, { recursive: true, force: true }));
  const withApp = { appRoot };

  test("served on 127.0.0.1, with its link, the no-framing headers and the SPA fallback", async () => {
    const { http, started } = startFake(undefined, withApp);
    const port = started.serving.port;
    expect(started.appLink).toBe(
      `http://127.0.0.1:${port}/#host=ws%3A%2F%2F127.0.0.1%3A${port}&token=${started.token}`,
    );
    const page = await fetch(`${http}/pr/tallyho/fieldbook/7`);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("<title>nod app</title>");
    expect(page.headers.get("x-frame-options")).toBe("DENY");
    expect(page.headers.get("cache-control")).toBe("no-cache");
    const sw = await fetch(`${http}/sw.js`);
    expect(sw.headers.get("cache-control")).toBe("no-cache");
    expect(await sw.text()).toContain("addEventListener");
    expect((await fetch(`${http}/../../etc/passwd`)).status).toBe(200); // the shell, never the file
    expect(await (await fetch(`${http}/%2e%2e/%2e%2e/etc/passwd`)).text()).toContain("nod app");
    // /health and the socket are not the page.
    expect((await (await fetch(`${http}/health`)).json()).name).toBe("nod");
  });

  test("without a build, loopback serves no page and has no app link", async () => {
    const { http, started } = startFake();
    expect(started.appLink).toBeNull();
    expect((await fetch(`${http}/`)).status).toBe(404);
  });

  test("localhost and [::1] are redirected to 127.0.0.1, path and query kept; /ws and /health are not", async () => {
    const { http, started } = startFake(undefined, withApp);
    const port = started.serving.port;
    for (const name of [`localhost:${port}`, `[::1]:${port}`, "LOCALHOST"]) {
      const res = await fetch(`${http}/pr/tallyho/fieldbook/7?x=1`, {
        headers: { Host: name },
        redirect: "manual",
      });
      expect(res.status).toBe(308);
      expect(res.headers.get("location")).toBe(
        `http://127.0.0.1:${port}/pr/tallyho/fieldbook/7?x=1`,
      );
    }
    const health = await fetch(`${http}/health`, { headers: { Host: `localhost:${port}` } });
    expect(health.status).toBe(200);
    const socket = await probe(started.wsUrl.replace("127.0.0.1", "localhost") + "/ws", {
      Host: `localhost:${port}`,
    });
    expect(socket.code).toBe(CLOSE_BAD_TOKEN);
  });

  test("DNS rebinding names get nothing: no page, no /health, no socket", async () => {
    const { http, started } = startFake(undefined, withApp);
    const port = started.serving.port;
    for (const name of [
      `evil.example.test:${port}`,
      `127.0.0.1.example.test:${port}`,
      `localhost.example.test:${port}`,
      `localhost.:${port}`,
      `2130706433:${port}`,
      `0x7f000001:${port}`,
      `127.1:${port}`,
    ]) {
      for (const path of ["/", "/sw.js", "/health", "/manifest.webmanifest"])
        expect((await fetch(`${http}${path}`, { headers: { Host: name } })).status).toBe(421);
      const socket = await probe(`${started.wsUrl}/ws?token=${started.token}`, { Host: name });
      expect(socket.opened).toBe(false);
      expect(socket.messages).toEqual([]);
    }
  });

  test("its origin is 127.0.0.1's only: the app's page pairs, a page on localhost or [::1] never does", async () => {
    const { http, started } = startFake(undefined, withApp);
    const port = started.serving.port;
    const app = `http://127.0.0.1:${port}`;
    const cors = (origin: string) =>
      fetch(`${http}/health`, { headers: { Origin: origin } }).then((r) =>
        r.headers.get("access-control-allow-origin"),
      );
    expect(await cors(app)).toBe(app);
    expect(await cors(`http://localhost:${port}`)).toBeNull();
    expect(await cors(`http://[::1]:${port}`)).toBeNull();
    const ok = await probe(`${started.wsUrl}/ws?token=${started.token}`, { Origin: app });
    expect(ok.messages[0]?.t).toBe("welcome");
    const no = await probe(`${started.wsUrl}/ws?token=${started.token}`, {
      Origin: `http://localhost:${port}`,
    });
    expect(no.opened).toBe(false);
    // Without the app, its origin is nobody's.
    const bare = startFake();
    const bareApp = `http://127.0.0.1:${bare.started.serving.port}`;
    const refused = await probe(`${bare.started.wsUrl}/ws?token=${bare.started.token}`, {
      Origin: bareApp,
    });
    expect(refused.opened).toBe(false);
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
      repos: [{ key: "tallyho/fieldbook" }],
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

describe("--allow-host: one named host behind a TLS proxy (ADR 0005)", () => {
  const NAME = "laptop.example-tailnet.ts.net";
  const host = parseNamedHost(`${NAME}:8445`);
  const webRoot = mkdtempSync(join(tmpdir(), "nod-web-"));
  writeFileSync(join(webRoot, "index.html"), "<!doctype html><title>nod</title>");
  afterAll(() => rmSync(webRoot, { recursive: true, force: true }));
  const named = { namedHost: { host, webRoot } };
  const onName = { Host: `${NAME}:8445` };

  test("without it, nothing changes: the name is refused, no page, no remote token", async () => {
    const { http, started, dir } = startFake(undefined, {});
    expect((await fetch(`${http}/`, { headers: onName })).status).toBe(421);
    expect((await fetch(`${http}/`)).status).toBe(404);
    expect([started.remoteToken, started.deviceLink]).toEqual([null, null]);
    expect(existsSync(join(dir, "serve-token-remote"))).toBe(false);
  });

  test("the named host gets the web app; loopback still does not; other names stay refused", async () => {
    const { http, started, dir } = startFake(undefined, named);
    // Its own token, kept next to the loopback one.
    expect(started.remoteToken).not.toBe(started.token);
    const file = join(dir, "serve-token-remote");
    expect(readFileSync(file, "utf8").trim()).toBe(started.remoteToken!);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(started.deviceLink).toBe(
      `https://${NAME}:8445/#host=wss%3A%2F%2F${NAME}%3A8445&token=${started.remoteToken}`,
    );
    expect(started.link).toContain(`token=${started.token}`);

    const page = await fetch(`${http}/pr/tallyho/fieldbook/7`, { headers: onName });
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("<title>nod</title>");
    expect(page.headers.get("x-frame-options")).toBe("DENY");
    expect(page.headers.get("content-security-policy")).toBe("frame-ancestors 'none'");
    expect((await fetch(`${http}/`)).status).toBe(404);
    for (const name of [
      `other.example-tailnet.ts.net:8445`,
      `${NAME}.evil.example`,
      `evil.${NAME}`,
      "evil.example",
    ])
      expect((await fetch(`${http}/`, { headers: { Host: name } })).status).toBe(421);
  });

  test("each side's allow-list: exactly the named origin there, loopback's unchanged", async () => {
    const { http } = startFake(undefined, named);
    const health = (headers: Record<string, string>) =>
      fetch(`${http}/health`, { headers }).then((r) =>
        r.headers.get("access-control-allow-origin"),
      );
    expect(await health({ ...onName, Origin: host.origin })).toBe(host.origin);
    expect(await health({ ...onName, Origin: "https://ui.nod.frebreco.de" })).toBeNull();
    expect(await health({ Origin: host.origin })).toBeNull();
    expect(await health({ Origin: "https://ui.nod.frebreco.de" })).toBe(
      "https://ui.nod.frebreco.de",
    );
  });

  test("the socket: each side opens only with its own token and its own origin", async () => {
    const { started, ws } = startFake(undefined, named);
    const remote = started.remoteToken!;
    const ok = await probe(ws(remote), { ...onName, Origin: host.origin });
    expect(ok.messages.map((m) => m.t)).toEqual(["welcome", "snapshot"]);
    // The loopback token does not open the named host, nor the remote token loopback.
    for (const [token, headers] of [
      [started.token, { ...onName, Origin: host.origin }],
      [remote, { Origin: DEV_WEB_URL }],
      [remote, {}],
      ["wrong", { ...onName, Origin: host.origin }],
    ] as const) {
      const result = await probe(ws(token), headers);
      expect(result.code).toBe(CLOSE_BAD_TOKEN);
      expect(result.messages).toEqual([]);
    }
    // Neither side lets in the other side's origin, nor any other.
    for (const [token, headers] of [
      [started.token, { Origin: host.origin }],
      [remote, { ...onName, Origin: "https://ui.nod.frebreco.de" }],
      [remote, { ...onName, Origin: DEV_WEB_URL }],
      [remote, { ...onName, Origin: `http://${NAME}:8445` }],
      [remote, { ...onName, Origin: `https://${NAME}` }],
      [remote, { ...onName, Origin: "https://evil.example" }],
    ] as const)
      expect((await probe(ws(token), headers)).opened).toBe(false);
  });

  test("a proxied request is never loopback: forwarded headers with a loopback Host get 421", async () => {
    // tailscale serve forwards the client's own Host and always sets
    // X-Forwarded-For/-Host/-Proto (finding 04), so a tailnet client asking
    // for Host 127.0.0.1 must not land on the loopback side.
    for (const extra of [{}, named]) {
      const { started, http, ws } = startFake(undefined, extra);
      for (const forwarded of <Record<string, string>[]>[
        { "X-Forwarded-For": "100.64.0.7" },
        { "X-Forwarded-Host": "127.0.0.1:4518" },
        { "X-Forwarded-Proto": "https" },
        { Forwarded: "for=100.64.0.7" },
      ]) {
        for (const loopback of ["127.0.0.1:4518", "localhost", "[::1]:4518"])
          expect(
            (await fetch(`${http}/health`, { headers: { ...forwarded, Host: loopback } })).status,
          ).toBe(421);
        const result = await probe(ws(started.token), forwarded);
        expect(result.opened).toBe(false);
        expect(result.messages).toEqual([]);
      }
    }
    // The proxy's own requests, on the named host, still get in.
    const { started, ws } = startFake(undefined, named);
    const proxied = await probe(ws(started.remoteToken!), {
      ...onName,
      Origin: host.origin,
      "X-Forwarded-For": "100.64.0.7",
      "X-Forwarded-Host": `${NAME}:8445`,
      "X-Forwarded-Proto": "https",
    });
    expect(proxied.messages.map((m) => m.t)).toEqual(["welcome", "snapshot"]);
  });

  test("an unlock on the desk does not let the phone sign, and back", async () => {
    const { started, ws } = startFake(undefined, named);
    class PhoneSocket extends WebSocket {
      constructor(url: string | URL) {
        super(url, { headers: { ...onName, Origin: host.origin } } as unknown as string[]);
      }
    }
    const desk = new NodClient(ws(started.token));
    const phone = new NodClient(ws(started.remoteToken!), { WebSocket: PhoneSocket });
    try {
      await until(() => [desk, phone].every((c) => c.state.snapshot !== null));
      const entries = [
        {
          repo: "tallyho/fieldbook",
          pr: 482,
          head_sha: desk.state.snapshot!.prs.find((p) => p.number === 482)!.headSha,
        },
      ];
      await desk.request("unlock", { passphrase: "pass" });
      await until(() => desk.state.signer?.state === "unlocked");
      expect(phone.state.signer?.state).toBe("locked");
      const refused = await phone
        .request("sign", { entries, verdict: "approve" })
        .catch((e: unknown) => e);
      expect((refused as RequestFailed).code).toBe("locked");

      await desk.request("lock", {});
      await phone.request("unlock", { passphrase: "pass" });
      await until(() => phone.state.signer?.state === "unlocked");
      expect(desk.state.signer?.state).toBe("locked");
      const result = await phone.request("sign", { entries, verdict: "approve" });
      expect(result.posted.map((p) => p.pr)).toEqual([482]);
    } finally {
      desk.close();
      phone.close();
    }
  });

  test("the app: the other device reads it, only this machine installs or gets the device link", async () => {
    const { started, ws, clock } = startFake(undefined, {
      ...named,
      app: { fake: { service: "running" } },
    });
    class PhoneSocket extends WebSocket {
      constructor(url: string | URL) {
        super(url, { headers: { ...onName, Origin: host.origin } } as unknown as string[]);
      }
    }
    const desk = new NodClient(ws(started.token), { maxBackoffMs: 50 });
    const phone = new NodClient(ws(started.remoteToken!), { WebSocket: PhoneSocket });
    try {
      await until(() => [desk, phone].every((c) => c.state.app?.update.kind === "upgrade"));
      expect(desk.state.app).toMatchObject({ version: "0.2.0", mayChange: true });
      expect(phone.state.app).toMatchObject({
        version: "0.2.0",
        mayChange: false,
        otherDevice: { origin: host.origin },
      });
      const refused = await phone
        .request("install-update", { version: "0.3.0" })
        .catch((e: unknown) => e);
      expect((refused as RequestFailed).code).toBe("forbidden");
      const link = await phone.request("device-link", {}).catch((e: unknown) => e);
      expect((link as RequestFailed).code).toBe("forbidden");
      const qr = await desk.request("device-link", {});
      expect(qr.origin).toBe(host.origin);
      expect(qr.qr.length).toBeGreaterThan(20);
      expect(qr.qr.every((row) => /^[01]+$/.test(row) && row.length === qr.qr.length)).toBe(true);

      // A click on this machine: installing, then the service restarts nod (played by the fake).
      await desk.request("install-update", { version: "0.3.0" });
      await until(() => phone.state.app?.update.installation.status === "installing");
      const reconnects = desk.state.reconnects;
      clock.advance(4000);
      await until(() => desk.state.app?.update.after?.state === "restarting");
      clock.advance(800);
      await until(() => desk.state.reconnects > reconnects && desk.state.status === "open", 5000);
      await until(() => desk.state.app?.version === "0.3.0", 5000);
      expect(desk.state.app?.update).toMatchObject({
        status: "up-to-date",
        installation: { status: "idle" },
        after: null,
      });
      expect((started.appSeams.service as unknown as { calls: string[] }).calls).toEqual([
        "restart",
      ]);
    } finally {
      desk.close();
      phone.close();
    }
  });

  test("renewing: --new-remote-token unpairs only the other device, --new-token both", async () => {
    const first = startFake(undefined, named);
    const { dir } = first;
    const before = [first.started.token, first.started.remoteToken];
    await first.started.stop();
    running.splice(running.indexOf(first.started), 1);
    const kept = startFake(undefined, named, dir);
    expect([kept.started.token, kept.started.remoteToken]).toEqual(before);
    await kept.started.stop();
    running.splice(running.indexOf(kept.started), 1);

    const remote = startFake(undefined, { ...named, newRemoteToken: true }, dir);
    expect(remote.started.token).toBe(before[0]!);
    expect(remote.started.remoteToken).not.toBe(before[1]!);
    await remote.started.stop();
    running.splice(running.indexOf(remote.started), 1);

    const both = startFake(undefined, { ...named, newToken: true }, dir);
    expect(both.started.token).not.toBe(before[0]!);
    expect(both.started.remoteToken).not.toBe(remote.started.remoteToken!);
    await both.started.stop();
    running.splice(running.indexOf(both.started), 1);

    // Without --allow-host it still renews the file, so a lost phone is cut off before the next run.
    const file = join(dir, "serve-token-remote");
    const old = readFileSync(file, "utf8");
    const plain = startFake(undefined, { newRemoteToken: true }, dir);
    expect(plain.started.remoteToken).toBeNull();
    expect(readFileSync(file, "utf8")).not.toBe(old);
    expect(plain.started.token).toBe(both.started.token);
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

      // the wake check's ping: answered at once, changes nothing
      await expect(client.request("ping", {})).resolves.toEqual({});

      const wrong = await client
        .request("unlock", { passphrase: "wrong" })
        .catch((e: unknown) => e);
      expect(wrong).toBeInstanceOf(RequestFailed);
      expect((wrong as RequestFailed).code).toBe("bad-passphrase");

      await client.request("unlock", { passphrase: "pass", minutes: 15 });
      await until(() => client.state.signer?.state === "unlocked");

      const pr = client.state.snapshot!.prs.find((p) => p.number === 482)!;
      const result = await client.request("sign", {
        entries: [{ repo: "tallyho/fieldbook", pr: 482, head_sha: pr.headSha }],
        verdict: "approve",
      });
      expect(result.posted.map((p) => p.pr)).toEqual([482]);
      await until(
        () => client.state.snapshot!.prs.find((p) => p.number === 482)!.needsMe === false,
      );

      await client.request("ack-fyi", { repo: "tallyho/fieldbook", pr: 478 });
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

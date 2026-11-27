/**
 * The login of the GitHub source (`account`, `gh()`): what a service that
 * starts without `gh`, without a login or before the network sees, and that
 * it gets out of it by itself. The fake GitHub and the token seam; temp
 * config and cache folders, never `~/.config/nod` or `~/.cache/nod`.
 */

import { join } from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import { tempDir } from "../kit/test-support.ts";
import { GH_RETRY_MS, type ServerToClient } from "../shared/protocol";
import { ManualClock } from "./clock";
import { addConfigRepo, type ConfigRepo } from "./config";
import { FakeGitHub } from "./github/fake-github";
import type { GhFailure } from "./github/gh";
import { ALICE, REPO, T0, rawPr, sha } from "./github/test-support";
import { githubSource } from "./github-source";
import { Session } from "./session";
import { FakeSigner } from "./signer";
import type { SourceChange } from "./source";

const settle = async () => {
  for (let i = 0; i < 30; i++) await Bun.sleep(0);
};

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

const WIDGETS: ConfigRepo = { host: "github.com", repo: REPO };
const NO_GH: GhFailure = { state: "no-gh", path: null, detail: null };
const NO_LOGIN: GhFailure = {
  state: "signed-out",
  path: "/opt/tools/bin/gh",
  detail: "no oauth token found for github.com",
};

/** A source on a temp list; `token` and `reachable` change what gh and GitHub say. */
async function login(o: { list?: ConfigRepo[]; token: string | GhFailure | null }) {
  const tmp = await tempDir();
  cleanups.push(tmp.cleanup);
  const configFile = join(tmp.dir, "config", "nod", "config.json");
  for (const r of o.list ?? []) addConfigRepo(configFile, r);
  const gh = new FakeGitHub();
  gh.open.push(rawPr({ number: 26 }));
  const state = { token: o.token, reachable: true, asked: 0 };
  const clock = new ManualClock(T0);
  const lines: string[] = [];
  const source = githubSource({
    clock,
    repo: null,
    cwd: tmp.dir,
    configFile,
    cacheDir: join(tmp.dir, "cache", "nod"),
    token: () => {
      state.asked++;
      return state.token;
    },
    fetch: () =>
      (async (input: RequestInfo | URL, init?: RequestInit) => {
        if (!state.reachable)
          throw new TypeError("Unable to connect. Is the computer able to access the url?");
        return gh.fetch(input, init);
      }) as typeof fetch,
    patchIds: { compute: async (i) => sha(`pid-${i.headSha}`) },
    log: (l) => lines.push(l),
  });
  cleanups.push(async () => source.stop());
  const changes: SourceChange[] = [];
  source.subscribe((c) => changes.push(c));
  await source.ready;
  await settle();
  const advance = async (ms: number) => {
    clock.advance(ms);
    await settle();
  };
  return { gh, source, state, lines, changes, advance, clock };
}

describe("the login", () => {
  test("an empty list with gh logged in: the account of github.com, signed in", async () => {
    const t = await login({ token: "t0ken" });
    expect(await t.source.account()).toMatchObject({ login: ALICE });
    expect(t.source.repos()).toEqual([]);
    expect(t.source.gh()).toMatchObject({ host: "github.com", state: "signed-in", detail: null });
    expect(t.lines).toContain("nod serve: signed in to github.com through gh");
  });

  test("no gh: `no-gh`, said once; gh installed later is picked up by itself", async () => {
    const t = await login({ token: NO_GH });
    expect(await t.source.account()).toBeNull();
    expect(t.source.gh()).toMatchObject({ state: "no-gh", path: null, checkedAt: T0 });
    expect(t.lines.filter((l) => l.includes("no gh on nod serve's PATH"))).toHaveLength(1);
    expect(t.changes).toContain("account");

    t.state.token = "t0ken";
    t.changes.length = 0;
    await t.advance(GH_RETRY_MS);
    expect(t.source.gh()).toMatchObject({ state: "signed-in" });
    expect(t.changes).toContain("account");
    expect(await t.source.account()).toMatchObject({ login: ALICE });
  });

  test("not logged in: gh's own words; a `gh auth login` meanwhile needs no restart", async () => {
    const t = await login({ list: [WIDGETS], token: NO_LOGIN });
    expect(await t.source.account()).toBeNull();
    expect(t.source.gh()).toMatchObject({
      state: "signed-out",
      path: "/opt/tools/bin/gh",
      detail: "no oauth token found for github.com",
    });
    expect(t.source.snapshot()).toBeNull();
    // gh is not asked on every look: once per GH_RETRY_MS.
    const asked = t.state.asked;
    await t.source.account();
    expect(t.state.asked).toBe(asked);

    t.state.token = "t0ken";
    await t.advance(GH_RETRY_MS);
    await t.advance(GH_RETRY_MS);
    expect(t.source.gh().state).toBe("signed-in");
    // The host, which waited for a login, reads now.
    expect(t.source.snapshot()?.prs.map((p) => p.number)).toEqual([26]);
  });

  test("GitHub not reachable yet (a service at boot): `unreachable`, not `signed-out`; read once it answers", async () => {
    const t = await login({ token: "t0ken" });
    t.state.reachable = false;
    expect(await t.source.account()).toBeNull();
    expect(t.source.gh()).toMatchObject({ state: "unreachable" });
    expect(t.source.gh().detail).toContain("Unable to connect");

    t.state.reachable = true;
    await t.advance(GH_RETRY_MS);
    expect(t.source.gh().state).toBe("signed-in");
  });

  test("a token GitHub refuses: `signed-out`, and gh is asked again for a new one", async () => {
    const t = await login({ token: "old-t0ken" });
    expect(await t.source.account()).toBeNull();
    expect(t.source.gh()).toMatchObject({
      state: "signed-out",
      detail: "GitHub refused gh's token for github.com",
    });
    t.state.token = "t0ken";
    expect(await t.source.account({ force: true })).toMatchObject({ login: ALICE });
  });

  test("`force` (Try again) asks gh at once, past the wait", async () => {
    const t = await login({ token: NO_LOGIN });
    await t.source.account();
    t.state.token = "t0ken";
    expect(await t.source.account()).toBeNull();
    expect(await t.source.account({ force: true })).toMatchObject({ login: ALICE });
  });
});

describe("the session", () => {
  test("the welcome says what nod serve sees of gh; `check-github` and the `account` push bring the login", async () => {
    const t = await login({ token: NO_LOGIN });
    const session = new Session({
      source: t.source,
      signer: new FakeSigner(t.clock),
      clock: t.clock,
      version: null,
      fake: false,
    });
    cleanups.push(async () => session.stop());
    const got: ServerToClient[] = [];
    const client = { side: "loopback" as const, send: (d: string) => got.push(JSON.parse(d)) };
    await session.attach(client);
    const welcome = got.find((m) => m.t === "welcome");
    expect(welcome).toMatchObject({
      me: null,
      repos: [],
      gh: {
        host: "github.com",
        state: "signed-out",
        detail: "no oauth token found for github.com",
      },
    });

    t.state.token = "t0ken";
    await session.handle(client, JSON.stringify({ t: "check-github", id: "1" }));
    await settle();
    expect(got.find((m) => m.t === "reply")).toMatchObject({
      ok: true,
      result: { me: { login: ALICE }, gh: { state: "signed-in" } },
    });
    expect(got.find((m) => m.t === "account")).toMatchObject({
      me: { login: ALICE },
      gh: { state: "signed-in" },
    });
  });
});

import { expect, test } from "bun:test";

import { githubHost } from "../../kit/host.ts";
import { GitHubApi, GitHubApiError, RateLimited } from "./api";

const TOKEN = "fake-token-for-tests-only";

function api(answer: (url: string, init: RequestInit) => Response, now = 1_000_000) {
  const seen: Array<{ url: string; init: RequestInit }> = [];
  const fetch = (async (url: string, init: RequestInit) => {
    seen.push({ url, init });
    return answer(url, init);
  }) as unknown as typeof globalThis.fetch;
  return { api: new GitHubApi({ token: TOKEN, fetch, now: () => now }), seen };
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers });

test("GraphQL: the token rides in the header only, and the budget is kept", async () => {
  const { api: gh, seen } = api(() =>
    json(200, {
      data: {
        viewer: { login: "alice" },
        rateLimit: { cost: 3, remaining: 4990, limit: 5000, resetAt: "2026-11-18T13:00:00Z" },
      },
    }),
  );
  expect(
    await gh.graphql<{ viewer: { login: string } }>("query { viewer { login } }"),
  ).toMatchObject({
    viewer: { login: "alice" },
  });
  expect(seen[0]!.url).toBe("https://api.github.com/graphql");
  expect(seen[0]!.url).not.toContain(TOKEN);
  expect((seen[0]!.init.headers as Record<string, string>).authorization).toBe(`Bearer ${TOKEN}`);
  expect(gh.budget).toEqual({
    cost: 3,
    remaining: 4990,
    limit: 5000,
    resetAt: Date.parse("2026-11-18T13:00:00Z"),
  });
  expect(gh.calls).toEqual({ graphql: 1, rest: 0, cost: 3 });
});

test("errors never carry the token", async () => {
  const { api: gh } = api(() => json(401, { message: `Bad credentials for ${TOKEN}` }));
  const error = await gh.rest("GET", "/user").catch((e: unknown) => e);
  expect(error).toBeInstanceOf(GitHubApiError);
  expect((error as Error).message).not.toContain(TOKEN);
  expect((error as Error).message).toContain("***");
  const graph = api(() => json(200, { errors: [{ message: `nope ${TOKEN}` }] }));
  expect(String(await graph.api.graphql("query { x }").catch((e: unknown) => e))).not.toContain(
    TOKEN,
  );
  const down = api(() => {
    throw new Error(`connect ECONNREFUSED ${TOKEN}`);
  });
  const e = await down.api.rest("GET", "/user").catch((x: unknown) => x);
  expect(e).toMatchObject({ status: 0 });
  expect(String(e)).not.toContain(TOKEN);
});

test("rate limits: secondary with retry-after, primary with the reset, GraphQL's RATE_LIMITED", async () => {
  const secondary = api(() =>
    json(403, { message: "You have exceeded a secondary rate limit." }, { "retry-after": "90" }),
  );
  expect(await secondary.api.rest("GET", "/x").catch((e: unknown) => e)).toEqual(
    expect.objectContaining({ name: "RateLimited", until: 1_000_000 + 90_000 }),
  );
  const primary = api(() =>
    json(
      403,
      { message: "API rate limit exceeded" },
      { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "2000" },
    ),
  );
  const p = await primary.api.rest("GET", "/x").catch((e: unknown) => e);
  expect(p).toBeInstanceOf(RateLimited);
  expect((p as RateLimited).until).toBe(2_000_000);
  const graph = api(() => json(200, { errors: [{ type: "RATE_LIMITED", message: "slow down" }] }));
  expect(await graph.api.graphql("query { x }").catch((e: unknown) => e)).toBeInstanceOf(
    RateLimited,
  );
  const tooMany = api(() => json(429, { message: "Too many" }));
  expect(
    ((await tooMany.api.rest("GET", "/x").catch((e: unknown) => e)) as RateLimited).until,
  ).toBeNull();
  // a plain 403 is not a rate limit
  const forbidden = api(() => json(403, { message: "Resource not accessible" }));
  const f = await forbidden.api.rest("GET", "/x").catch((e: unknown) => e);
  expect(f).toBeInstanceOf(GitHubApiError);
  expect(f).not.toBeInstanceOf(RateLimited);
});

test("REST: JSON in and out, headers kept, empty bodies are null", async () => {
  const { api: gh, seen } = api((url) =>
    url.endsWith("/empty")
      ? new Response("", { status: 204 })
      : json(201, { id: 1 }, { "x-oauth-scopes": "repo" }),
  );
  const r = await gh.rest<{ id: number }>("POST", "/repos/acme/widgets/issues/1/comments", {
    body: "hi",
  });
  expect(r.data).toEqual({ id: 1 });
  expect(r.headers.get("x-oauth-scopes")).toBe("repo");
  expect(seen[0]!.init.body).toBe('{"body":"hi"}');
  expect((await gh.rest("DELETE", "/empty")).data).toBeNull();
});

test("the URLs come from the host: GHE.com and GitHub Enterprise Server", async () => {
  for (const [host, graphql, rest] of [
    ["acme.ghe.com", "https://api.acme.ghe.com/graphql", "https://api.acme.ghe.com/user"],
    [
      "git.example.test",
      "https://git.example.test/api/graphql",
      "https://git.example.test/api/v3/user",
    ],
  ] as const) {
    const seen: string[] = [];
    const fetch = (async (url: string) => {
      seen.push(url);
      return json(200, { data: { ok: true } });
    }) as unknown as typeof globalThis.fetch;
    const gh = new GitHubApi({ token: TOKEN, host: githubHost(host), fetch });
    await gh.graphql("query { ok }");
    await gh.rest("GET", "/user");
    expect(seen).toEqual([graphql, rest]);
  }
});

test("the token never follows a redirect to another host, github.com and GHE.com alike", async () => {
  for (const [host, away] of [
    ["github.com", "https://api.acme.ghe.com/user"],
    ["acme.ghe.com", "https://api.github.com/user"],
    ["git.example.test", "https://git.example.test.example.invalid/api/v3/user"],
  ] as const) {
    const seen: Array<{ url: string; auth: string }> = [];
    const fetch = (async (url: string, init: RequestInit) => {
      seen.push({ url, auth: (init.headers as Record<string, string>).authorization! });
      return new Response(null, { status: 302, headers: { location: away } });
    }) as unknown as typeof globalThis.fetch;
    const gh = new GitHubApi({ token: TOKEN, host: githubHost(host), fetch });
    const error = await gh.rest("GET", "/user").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GitHubApiError);
    expect(String(error)).toContain("refusing to send the token");
    expect(seen).toHaveLength(1);
    expect(seen.some((s) => s.url === away)).toBe(false);
  }
});

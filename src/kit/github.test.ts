import { describe, expect, test } from "bun:test";

import {
  createCheckRun,
  getPullRequest,
  GitHubError,
  listIssueComments,
  syncLabels,
  upsertStickyComment,
  type GitHubOptions,
} from "./github.ts";
import { STICKY_MARKER } from "./sticky.ts";

type Call = { method: string; url: string; body: unknown; headers: Record<string, string> };

/** A fake fetch answering from a route table; records every call. */
function fake(routes: Record<string, (call: Call) => unknown>) {
  const calls: Call[] = [];
  const doFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const call: Call = {
      method: init?.method ?? "GET",
      url: String(input),
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
      headers: (init?.headers ?? {}) as Record<string, string>,
    };
    calls.push(call);
    const path = call.url.replace("https://api.github.com", "");
    const handler = routes[`${call.method} ${path}`];
    if (!handler) return new Response(JSON.stringify({ message: "Not Found" }), { status: 404 });
    const out = handler(call);
    return out instanceof Response
      ? out
      : new Response(JSON.stringify(out ?? null), { status: 200 });
  }) as typeof fetch;
  const options: GitHubOptions = { token: "tok-123", repo: "acme/widgets", fetch: doFetch };
  return { calls, options };
}

describe("github helpers", () => {
  test("getPullRequest maps the fields and sends auth headers", async () => {
    const { calls, options } = fake({
      "GET /repos/acme/widgets/pulls/6": () => ({
        number: 6,
        title: "Add a thing",
        body: null,
        user: { login: "alice" },
        labels: [{ name: "nod:decide" }],
        base: { ref: "main" },
        head: { sha: "6".repeat(40) },
        state: "open",
        draft: false,
      }),
    });
    expect(await getPullRequest(options, 6)).toEqual({
      number: 6,
      title: "Add a thing",
      body: "",
      author: "alice",
      labels: ["nod:decide"],
      base: "main",
      head_sha: "6".repeat(40),
      state: "open",
      draft: false,
    });
    expect(calls[0]!.headers.authorization).toBe("Bearer tok-123");
    expect(calls[0]!.headers["x-github-api-version"]).toBe("2022-11-28");
  });

  test("listIssueComments follows pages", async () => {
    const page = (n: number, from: number) =>
      Array.from({ length: n }, (_, i) => ({
        id: from + i,
        body: `c${from + i}`,
        user: { login: "alice", type: "User" },
        created_at: "t",
        updated_at: "t",
      }));
    const { calls, options } = fake({
      "GET /repos/acme/widgets/issues/6/comments?per_page=100&page=1": () => page(100, 0),
      "GET /repos/acme/widgets/issues/6/comments?per_page=100&page=2": () => page(3, 100),
    });
    const comments = await listIssueComments(options, 6);
    expect(comments).toHaveLength(103);
    expect(comments[102]).toEqual({
      id: 102,
      body: "c102",
      author: "alice",
      authorType: "User",
      created_at: "t",
      updated_at: "t",
    });
    expect(calls).toHaveLength(2);
  });

  test("createCheckRun posts a completed run on the head SHA", async () => {
    const { calls, options } = fake({ "POST /repos/acme/widgets/check-runs": () => ({ id: 99 }) });
    const id = await createCheckRun(options, {
      head_sha: "6".repeat(40),
      conclusion: "failure",
      title: "waiting for a peer nod",
      summary: "requirement: peer",
      text: "x",
    });
    expect(id).toBe(99);
    expect(calls[0]!.body).toEqual({
      name: "nod",
      head_sha: "6".repeat(40),
      status: "completed",
      conclusion: "failure",
      output: { title: "waiting for a peer nod", summary: "requirement: peer", text: "x" },
    });
  });

  test("createCheckRun refuses neutral or skipped", async () => {
    const { options } = fake({});
    const bad = {
      head_sha: "6".repeat(40),
      conclusion: "neutral",
      title: "",
      summary: "",
    } as unknown as Parameters<typeof createCheckRun>[1];
    await expect(createCheckRun(options, bad)).rejects.toThrow("only success or failure");
  });

  test("upsertStickyComment edits the bot's comment, ignores a planted marker", async () => {
    const comments = [
      {
        id: 1,
        body: `${STICKY_MARKER}\nplanted`,
        user: { login: "alice", type: "User" },
        created_at: "t",
        updated_at: "t",
      },
      {
        id: 2,
        body: `${STICKY_MARKER}\nold`,
        user: { login: "github-actions[bot]", type: "Bot" },
        created_at: "t",
        updated_at: "t",
      },
    ];
    const { calls, options } = fake({
      "GET /repos/acme/widgets/issues/6/comments?per_page=100&page=1": () => comments,
      "PATCH /repos/acme/widgets/issues/comments/2": () => ({ id: 2 }),
    });
    expect(await upsertStickyComment(options, 6, `${STICKY_MARKER}\nnew`)).toBe(2);
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      "GET https://api.github.com/repos/acme/widgets/issues/6/comments?per_page=100&page=1",
      "PATCH https://api.github.com/repos/acme/widgets/issues/comments/2",
    ]);
    expect(calls[1]!.body).toEqual({ body: `${STICKY_MARKER}\nnew` });
  });

  test("upsertStickyComment creates one when there is none, and skips unchanged bodies", async () => {
    const { calls, options } = fake({
      "GET /repos/acme/widgets/issues/6/comments?per_page=100&page=1": () => [],
      "POST /repos/acme/widgets/issues/6/comments": () => ({ id: 7 }),
    });
    expect(await upsertStickyComment(options, 6, `${STICKY_MARKER}\nhi`)).toBe(7);
    expect(calls.at(-1)!.method).toBe("POST");

    const same = fake({});
    const existing = [
      {
        id: 3,
        body: "<!-- nod:sticky -->\nhi",
        author: "nod-app[bot]",
        authorType: "Bot",
        created_at: "t",
        updated_at: "t",
      },
    ];
    expect(
      await upsertStickyComment(same.options, 6, "<!-- nod:sticky -->\nhi", {
        comments: existing,
        author: "nod-app[bot]",
      }),
    ).toBe(3);
    expect(same.calls).toEqual([]);
  });

  test("syncLabels only touches its own prefix", async () => {
    const { calls, options } = fake({
      "DELETE /repos/acme/widgets/issues/6/labels/nod%3Aauto": () => [],
      "POST /repos/acme/widgets/issues/6/labels": () => [],
    });
    const r = await syncLabels(options, 6, ["nod:decide", "nod:risk-3"], {
      current: ["bug", "nod:auto", "nod:risk-3"],
    });
    expect(r).toEqual({ added: ["nod:decide"], removed: ["nod:auto"] });
    expect(calls.map((c) => c.method)).toEqual(["DELETE", "POST"]);
    expect(calls[1]!.body).toEqual({ labels: ["nod:decide"] });
  });

  test("errors carry the status and never the token", async () => {
    const { options } = fake({
      "GET /repos/acme/widgets/pulls/6": () =>
        new Response(JSON.stringify({ message: "Bad credentials tok-123" }), { status: 401 }),
    });
    const err = await getPullRequest(options, 6).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GitHubError);
    expect((err as GitHubError).status).toBe(401);
    expect((err as Error).message).not.toContain("tok-123");
  });

  test("bad repo names and numbers never reach fetch", async () => {
    const { calls, options } = fake({});
    await expect(getPullRequest({ ...options, repo: "acme/../x?y" }, 6)).rejects.toThrow(
      "owner/name",
    );
    await expect(getPullRequest(options, -1)).rejects.toThrow("not a valid number");
    expect(calls).toEqual([]);
  });

  test("apiUrl for GitHub Enterprise", async () => {
    const { calls, options } = fake({});
    await getPullRequest({ ...options, apiUrl: "https://ghe.example.test/api/v3/" }, 6).catch(
      () => {},
    );
    expect(calls[0]!.url).toBe("https://ghe.example.test/api/v3/repos/acme/widgets/pulls/6");
  });

  test("the token stays with apiUrl: a redirect to another host is refused, not followed", async () => {
    const { calls, options } = fake({
      "GET /repos/acme/widgets/pulls/6": () =>
        new Response(null, {
          status: 307,
          headers: { location: "https://api.github.com.example.test/x" },
        }),
    });
    await expect(getPullRequest(options, 6)).rejects.toThrow(/refusing to send the token/);
    expect(calls.map((c) => c.url)).toEqual(["https://api.github.com/repos/acme/widgets/pulls/6"]);
    // GHE.com: managed users own repos too.
    const ghe = fake({});
    await getPullRequest(
      { ...ghe.options, repo: "mona_acme/widgets", apiUrl: "https://api.acme.ghe.com" },
      6,
    ).catch(() => {});
    expect(ghe.calls[0]!.url).toBe("https://api.acme.ghe.com/repos/mona_acme/widgets/pulls/6");
    expect(ghe.calls[0]!.headers.authorization).toBe("Bearer tok-123");
  });
});

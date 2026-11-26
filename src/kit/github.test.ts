import { describe, expect, test } from "bun:test";

import { getEnforcement, requiredByProtection, requiredByRules } from "./enforcement.ts";
import {
  canWrite,
  createCheckRun,
  getPullRequest,
  getRepoPermission,
  GitHubError,
  listIssueComments,
  listReviews,
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

  test("createCheckRun takes neutral (not enforced), refuses skipped", async () => {
    const { calls, options } = fake({ "POST /repos/acme/widgets/check-runs": () => ({ id: 5 }) });
    await createCheckRun(options, {
      head_sha: "6".repeat(40),
      conclusion: "neutral",
      title: "waiting for a peer approval or nod",
      summary: "",
    });
    expect((calls[0]!.body as { conclusion: string }).conclusion).toBe("neutral");
    const bad = {
      head_sha: "6".repeat(40),
      conclusion: "skipped",
      title: "",
      summary: "",
    } as unknown as Parameters<typeof createCheckRun>[1];
    await expect(createCheckRun(options, bad)).rejects.toThrow("only success, failure or neutral");
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

  test("upsertStickyComment with create: false updates one but never creates one", async () => {
    const { calls, options } = fake({
      "GET /repos/acme/widgets/issues/6/comments?per_page=100&page=1": () => [],
    });
    expect(await upsertStickyComment(options, 6, `${STICKY_MARKER}\nhi`, { create: false })).toBe(
      null,
    );
    expect(calls.map((c) => c.method)).toEqual(["GET"]);
    const existing = [
      {
        id: 4,
        body: `${STICKY_MARKER}\nold`,
        author: "github-actions[bot]",
        authorType: "Bot",
        created_at: "t",
        updated_at: "t",
      },
    ];
    const upd = fake({ "PATCH /repos/acme/widgets/issues/comments/4": () => ({ id: 4 }) });
    expect(
      await upsertStickyComment(upd.options, 6, `${STICKY_MARKER}\nnew`, {
        comments: existing,
        create: false,
      }),
    ).toBe(4);
  });

  test("listReviews maps the fields and follows pages", async () => {
    const { options } = fake({
      "GET /repos/acme/widgets/pulls/6/reviews?per_page=100&page=1": () => [
        {
          user: { login: "bob", type: "User" },
          state: "APPROVED",
          commit_id: "6".repeat(40),
          submitted_at: "2026-11-26T09:00:00Z",
        },
        { user: null, state: "COMMENTED" },
      ],
    });
    expect(await listReviews(options, 6)).toEqual([
      {
        reviewer: "bob",
        reviewerType: "User",
        state: "APPROVED",
        commit_id: "6".repeat(40),
        submitted_at: "2026-11-26T09:00:00Z",
      },
      { reviewer: "", reviewerType: "", state: "COMMENTED", commit_id: null, submitted_at: null },
    ]);
  });

  test("getRepoPermission reads role_name, else permission; canWrite", async () => {
    const { options } = fake({
      "GET /repos/acme/widgets/collaborators/bob/permission": () => ({
        permission: "write",
        role_name: "maintain",
      }),
      "GET /repos/acme/widgets/collaborators/carol/permission": () => ({ permission: "read" }),
    });
    expect(await getRepoPermission(options, "bob")).toBe("maintain");
    expect(await getRepoPermission(options, "carol")).toBe("read");
    await expect(getRepoPermission(options, "dave")).rejects.toThrow("GitHub 404");
    expect(["admin", "maintain", "write"].every((p) => canWrite(p as "write"))).toBe(true);
    expect(canWrite("triage") || canWrite("read") || canWrite("none")).toBe(false);
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

describe("enforcement (ADR 0006)", () => {
  const RULES = "GET /repos/acme/widgets/rules/branches/main";
  const BRANCH = "GET /repos/acme/widgets/branches/main";
  const unprotected = () => ({ name: "main", protected: false });
  const nodRule = {
    type: "required_status_checks",
    parameters: { required_status_checks: [{ context: "nod", integration_id: 15368 }] },
  };

  test("a ruleset requiring nod: enforced by the ruleset, the branch is not asked", async () => {
    const { calls, options } = fake({ [RULES]: () => [{ type: "deletion" }, nodRule] });
    expect(await getEnforcement(options, "main")).toEqual({ enforced: true, by: "ruleset" });
    expect(calls).toHaveLength(1);
  });

  test("no rule and no protection: not enforced", async () => {
    const { options } = fake({
      [RULES]: () => [
        {
          type: "required_status_checks",
          parameters: { required_status_checks: [{ context: "test" }] },
        },
      ],
      [BRANCH]: unprotected,
    });
    expect(await getEnforcement(options, "main")).toEqual({ enforced: false, by: null });
  });

  test("classic branch protection requiring nod: enforced", async () => {
    const { options } = fake({
      [RULES]: () => [],
      [BRANCH]: () => ({
        protected: true,
        protection: {
          enabled: true,
          required_status_checks: {
            enforcement_level: "non_admins",
            contexts: ["nod"],
            checks: [{ context: "nod", app_id: 15368 }],
          },
        },
      }),
    });
    expect(await getEnforcement(options, "main")).toEqual({
      enforced: true,
      by: "branch_protection",
    });
  });

  test("a failed lookup counts as enforced, with the reason", async () => {
    const { options } = fake({
      [RULES]: () => new Response(JSON.stringify({ message: "Server Error" }), { status: 500 }),
    });
    const e = await getEnforcement(options, "main");
    expect(e).toMatchObject({ enforced: true, by: "unknown" });
    expect(e.detail).toContain("GitHub 500");
    expect(e.detail).not.toContain("tok-123");
  });

  test("a protected branch whose required checks are not readable counts as enforced", async () => {
    const { options } = fake({ [RULES]: () => [], [BRANCH]: () => ({ protected: true }) });
    expect(await getEnforcement(options, "main")).toMatchObject({ enforced: true, by: "unknown" });
  });

  test("enforced: true in the policy asks nobody", async () => {
    const { calls, options } = fake({});
    expect(await getEnforcement(options, "main", { policy: { enforced: true } })).toEqual({
      enforced: true,
      by: "policy",
    });
    expect(calls).toEqual([]);
  });

  test("a branch with slashes keeps them; odd characters are encoded", async () => {
    const { calls, options } = fake({
      "GET /repos/acme/widgets/rules/branches/stack/part%231": () => [],
      "GET /repos/acme/widgets/branches/stack/part%231": unprotected,
    });
    expect(await getEnforcement(options, "stack/part#1")).toEqual({ enforced: false, by: null });
    expect(calls).toHaveLength(2);
  });

  test("the parsers", () => {
    expect(requiredByRules([nodRule])).toBe(true);
    expect(requiredByRules([nodRule], "other")).toBe(false);
    expect(() => requiredByRules({ message: "x" })).toThrow();
    // the sandbox's shape: protected by a ruleset only, classic checks off
    expect(
      requiredByProtection({
        protected: true,
        protection: {
          enabled: false,
          required_status_checks: { checks: [], contexts: [], enforcement_level: "off" },
        },
      }),
    ).toBe(false);
    expect(
      requiredByProtection({
        protected: true,
        protection: {
          required_status_checks: { enforcement_level: "everyone", contexts: ["ci"], checks: [] },
        },
      }),
    ).toBe(false);
    expect(requiredByProtection({ protected: true, protection: {} })).toBe(null);
    expect(requiredByProtection(null)).toBe(false);
  });
});

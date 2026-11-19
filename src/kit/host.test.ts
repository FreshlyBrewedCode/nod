import { describe, expect, test } from "bun:test";

import {
  fetchWithToken,
  ghLoginCommand,
  githubHost,
  hostName,
  isApiUrl,
  parseRemote,
  sameHost,
  TokenHostError,
} from "./host.ts";

describe("githubHost: one host, its endpoints", () => {
  test("github.com", () => {
    expect(githubHost("github.com")).toEqual({
      name: "github.com",
      kind: "github.com",
      webUrl: "https://github.com",
      apiUrl: "https://api.github.com",
      graphqlUrl: "https://api.github.com/graphql",
    });
    expect(githubHost("https://GitHub.com/").name).toBe("github.com");
  });

  test("GHE.com with data residency: api.<name>.ghe.com", () => {
    expect(githubHost("acme.ghe.com")).toEqual({
      name: "acme.ghe.com",
      kind: "ghe.com",
      webUrl: "https://acme.ghe.com",
      apiUrl: "https://api.acme.ghe.com",
      graphqlUrl: "https://api.acme.ghe.com/graphql",
    });
    // GITHUB_SERVER_URL as Actions sets it.
    expect(githubHost("https://acme.ghe.com").kind).toBe("ghe.com");
  });

  test("any other host is a GitHub Enterprise Server: /api/v3 and /api/graphql", () => {
    expect(githubHost("git.example.test")).toEqual({
      name: "git.example.test",
      kind: "server",
      webUrl: "https://git.example.test",
      apiUrl: "https://git.example.test/api/v3",
      graphqlUrl: "https://git.example.test/api/graphql",
    });
    expect(githubHost("GIT.example.test:8443").apiUrl).toBe("https://git.example.test:8443/api/v3");
  });

  test("odd inputs are refused", () => {
    for (const bad of [
      "",
      " ",
      "github.com/acme",
      "https://github.com/acme/widgets",
      "https://user@github.com",
      "acme_corp.example.test",
      "-acme.example.test",
      "acme..example.test",
      "acme.example.test:0",
      "acme.example.test:port",
      "git.example.test:123456",
      "*.ghe.com",
      "acme.ghe.com;rm",
      "api.github.com",
      "gist.github.com",
      "ghe.com",
      "api.acme.ghe.com",
      "a.b.ghe.com",
      "acme.ghe.com:8443",
    ])
      expect(() => githubHost(bad), bad).toThrow();
  });

  test("hostName and sameHost", () => {
    expect(hostName("https://ACME.ghe.com/")).toBe("acme.ghe.com");
    expect(hostName("ftp://acme.ghe.com")).toBeNull();
    expect(sameHost("github.com", "https://github.com")).toBe(true);
    expect(sameHost("github.com", "acme.ghe.com")).toBe(false);
    expect(sameHost("x y", "x y")).toBe(false);
  });

  test("the gh login command names the host off github.com", () => {
    expect(ghLoginCommand("github.com")).toBe("gh auth login");
    expect(ghLoginCommand("acme.ghe.com")).toBe("gh auth login --hostname acme.ghe.com");
  });
});

describe("parseRemote: the origin in every spelling", () => {
  const cases: Array<[string, string, string, boolean]> = [
    ["https://github.com/acme/widgets.git", "github.com", "acme/widgets", false],
    ["https://github.com/acme/widgets", "github.com", "acme/widgets", false],
    ["https://github.com/acme/widgets/", "github.com", "acme/widgets", false],
    ["https://someone@github.com/acme/widgets.git", "github.com", "acme/widgets", false],
    ["git@github.com:acme/widgets.git", "github.com", "acme/widgets", true],
    ["git@github.com:acme/widgets", "github.com", "acme/widgets", true],
    ["ssh://git@github.com/acme/widgets.git", "github.com", "acme/widgets", true],
    ["ssh://git@github.com:22/acme/widgets", "github.com", "acme/widgets", true],
    ["git://github.com/acme/widgets", "github.com", "acme/widgets", false],
    // GHE.com: the ssh user is the enterprise's subdomain.
    ["https://acme.ghe.com/acme/widgets.git", "acme.ghe.com", "acme/widgets", false],
    ["acme@acme.ghe.com:acme/widgets.git", "acme.ghe.com", "acme/widgets", true],
    ["ssh://acme@acme.ghe.com/mona_acme/widgets.git/", "acme.ghe.com", "mona_acme/widgets", true],
    // GHES, with ports: an https port is the server's, an ssh port is not.
    [
      "https://git.example.test:8443/acme/widgets.git",
      "git.example.test:8443",
      "acme/widgets",
      false,
    ],
    ["ssh://git@git.example.test:2222/acme/widgets.git", "git.example.test", "acme/widgets", true],
    ["git@GIT.example.test:Acme/Widgets.git", "git.example.test", "Acme/Widgets", true],
  ];
  for (const [url, host, repo, ssh] of cases)
    test(url, () => expect(parseRemote(url)).toEqual({ host, repo, ssh, alias: false }));

  test("ssh aliases are recognised, not resolved", () => {
    for (const url of [
      "git@work:acme/widgets.git",
      "git@github.com-work:acme/widgets.git",
      "git@gh_work:acme/widgets.git",
      "ssh://git@acme.ghe.com-work/acme/widgets",
    ])
      expect(parseRemote(url), url).toMatchObject({ repo: "acme/widgets", alias: true });
  });

  test("local paths and other things are not GitHub remotes", () => {
    for (const url of [
      "/srv/git/widgets.git",
      "../widgets",
      "file:///srv/git/acme/widgets.git",
      "https://github.com/acme",
      "https://github.com/acme/widgets/tree/main",
      "https://github.com/acme/..",
      "https://under_score.example.test/acme/widgets",
      "",
    ])
      expect(parseRemote(url), url).toBeNull();
  });
});

describe("a token goes to its own host's API only", () => {
  const com = githubHost("github.com");
  const ghe = githubHost("acme.ghe.com");
  const ghes = githubHost("git.example.test");

  test("isApiUrl", () => {
    expect(isApiUrl(com, "https://api.github.com/graphql")).toBe(true);
    expect(isApiUrl(com, "https://api.github.com/repos/acme/widgets")).toBe(true);
    expect(isApiUrl(ghe, "https://api.acme.ghe.com/graphql")).toBe(true);
    expect(isApiUrl(ghes, "https://git.example.test/api/v3/user")).toBe(true);
    expect(isApiUrl(ghes, "https://git.example.test/api/graphql")).toBe(true);
    for (const [host, url] of [
      [com, "https://api.acme.ghe.com/graphql"],
      [ghe, "https://api.github.com/graphql"],
      [com, "https://github.com/login"],
      [com, "http://api.github.com/graphql"],
      [com, "https://api.github.com.example.test/graphql"],
      [com, "https://user:pass@api.github.com/graphql"],
      [ghe, "https://api.other.ghe.com/graphql"],
      [ghes, "https://git.example.test/login"],
      [ghes, "https://git.example.test:8443/api/v3/user"],
      [ghes, "not a url"],
    ] as const)
      expect(isApiUrl(host, url), url).toBe(false);
  });

  function recorder(answers: Record<string, Response | (() => Response)>) {
    const sent: Array<{ url: string; auth: string | undefined; method: string }> = [];
    const fetch = (async (url: string, init: RequestInit) => {
      sent.push({
        url,
        auth: (init.headers as Record<string, string>).authorization,
        method: init.method ?? "GET",
      });
      expect(init.redirect).toBe("manual");
      const a = answers[url];
      if (!a) return new Response("{}", { status: 200 });
      return typeof a === "function" ? a() : a;
    }) as unknown as typeof globalThis.fetch;
    return { sent, fetch };
  }
  const redirect = (to: string, status = 302) =>
    new Response(null, { status, headers: { location: to } });

  test("a github.com token is never sent to a GHE.com URL, nor the reverse", async () => {
    for (const [host, url] of [
      [com, "https://api.acme.ghe.com/user"],
      [ghe, "https://api.github.com/user"],
    ] as const) {
      const r = recorder({});
      await expect(
        fetchWithToken(url, {}, { token: "t", fetch: r.fetch, allowed: (u) => isApiUrl(host, u) }),
      ).rejects.toBeInstanceOf(TokenHostError);
      expect(r.sent).toEqual([]);
    }
  });

  test("redirects within the API are followed with the token; across hosts they are not", async () => {
    const r = recorder({
      "https://api.github.com/repos/old/name": redirect("/repositories/1", 301),
      "https://api.github.com/repositories/1": new Response('{"ok":true}', { status: 200 }),
    });
    const ok = await fetchWithToken(
      "https://api.github.com/repos/old/name",
      {},
      { token: "t", fetch: r.fetch, allowed: (u) => isApiUrl(com, u) },
    );
    expect(await ok.json()).toEqual({ ok: true });
    expect(r.sent.map((s) => [s.url, s.auth])).toEqual([
      ["https://api.github.com/repos/old/name", "Bearer t"],
      ["https://api.github.com/repositories/1", "Bearer t"],
    ]);

    for (const to of [
      "https://api.github.com.example.test/x",
      "https://api.acme.ghe.com/x",
      "http://api.github.com/x",
      "https://github.com/login",
    ]) {
      const away = recorder({ "https://api.github.com/user": redirect(to, 307) });
      await expect(
        fetchWithToken(
          "https://api.github.com/user",
          { method: "POST", body: "{}" },
          { token: "t", fetch: away.fetch, allowed: (u) => isApiUrl(com, u) },
        ),
      ).rejects.toThrow(/refusing to send the token/);
      expect(away.sent.map((s) => s.url)).toEqual(["https://api.github.com/user"]);
    }
  });

  test("a redirect loop ends", async () => {
    const r = recorder({ "https://api.github.com/a": () => redirect("/a") });
    await expect(
      fetchWithToken(
        "https://api.github.com/a",
        {},
        { token: "t", fetch: r.fetch, allowed: (u) => isApiUrl(com, u) },
      ),
    ).rejects.toThrow(/too many redirects/);
    expect(r.sent).toHaveLength(4);
  });

  test("a 303 turns into a GET without the body", async () => {
    const r = recorder({ "https://api.github.com/a": redirect("/b", 303) });
    await fetchWithToken(
      "https://api.github.com/a",
      { method: "POST", body: "{}" },
      { token: "t", fetch: r.fetch, allowed: (u) => isApiUrl(com, u) },
    );
    expect(r.sent.map((s) => s.method)).toEqual(["POST", "GET"]);
  });
});

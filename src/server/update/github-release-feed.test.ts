import { expect, test } from "bun:test";

import { GitHubReleaseFeed, MAX_PAGES } from "./github-release-feed";
import { FeedError, FeedRateLimited, parseReleases, selectRelease } from "./release-feed";

/** The shape of GitHub's release list, trimmed to what nod reads (recorded from the real answer). */
const release = (tag: string, extra: Record<string, unknown> = {}) => ({
  url: `https://api.github.com/repos/FreshlyBrewedCode/nod/releases/1`,
  html_url: `https://github.com/FreshlyBrewedCode/nod/releases/tag/${tag}`,
  tag_name: tag,
  name: tag,
  draft: false,
  prerelease: tag.includes("-"),
  created_at: "2026-11-26T18:29:41Z",
  published_at: "2026-11-26T18:30:13Z",
  body: `# [${tag}](https://github.com/FreshlyBrewedCode/nod/compare/v0.1.0...${tag})\n\n### Features\n\n* a thing`,
  assets: [],
  ...extra,
});

const NEXT_FIRST = [
  release("v0.2.0-next.6"),
  release("v0.2.0-next.10"),
  release("v0.2.0-next.5"),
  release("v0.1.1"),
  release("v0.1.0"),
];

test("parseReleases: tags become versions, drafts and odd entries go", () => {
  const parsed = parseReleases([
    ...NEXT_FIRST,
    release("v0.3.0", { draft: true }),
    release("not-a-version"),
    release("v0.1.2", { body: null, published_at: null }),
    null,
    "x",
  ]);
  expect(parsed.map((r) => r.version)).toEqual([
    "0.2.0-next.6",
    "0.2.0-next.10",
    "0.2.0-next.5",
    "0.1.1",
    "0.1.0",
    "0.1.2",
  ]);
  expect(parsed[0]).toMatchObject({
    prerelease: true,
    publishedAt: "2026-11-26T18:30:13Z",
    url: "https://github.com/FreshlyBrewedCode/nod/releases/tag/v0.2.0-next.6",
  });
  expect(parsed[0]!.notes).toContain("### Features");
  expect(parsed.at(-1)).toMatchObject({ notes: "", publishedAt: "2026-11-26T18:29:41Z" });
  expect(parseReleases({ message: "Not Found" })).toEqual([]);
});

test("selectRelease: stable skips pre-releases, next takes the newest of all, by semver", () => {
  const releases = parseReleases(NEXT_FIRST);
  expect(selectRelease(releases, "stable")?.version).toBe("0.1.1");
  expect(selectRelease(releases, "next")?.version).toBe("0.2.0-next.10");
  // A stable release newer than every pre-release is what next wants, too.
  const withStable = parseReleases([...NEXT_FIRST, release("v0.2.0")]);
  expect(selectRelease(withStable, "next")?.version).toBe("0.2.0");
  expect(selectRelease([], "stable")).toBeNull();
  expect(selectRelease(parseReleases([release("v0.1.0-next.1")]), "stable")).toBeNull();
});

function feedOver(answer: (url: string, init: RequestInit) => Response, now = 1_000_000) {
  const seen: Array<{ url: string; headers: Record<string, string> }> = [];
  const fetch = (async (url: string, init: RequestInit) => {
    seen.push({ url, headers: init.headers as Record<string, string> });
    return answer(url, init);
  }) as unknown as typeof globalThis.fetch;
  return { feed: new GitHubReleaseFeed({ fetch, now: () => now }), seen };
}

const ok = (body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status: 200, headers: { etag: 'W/"abc"', ...headers } });

test("asks the public API for the repository's releases, with no credentials", async () => {
  const { feed, seen } = feedOver(() => ok(NEXT_FIRST));
  expect((await feed.latest("next"))?.version).toBe("0.2.0-next.10");
  expect(seen).toHaveLength(1);
  expect(seen[0]!.url).toBe(
    "https://api.github.com/repos/FreshlyBrewedCode/nod/releases?per_page=100",
  );
  expect(Object.keys(seen[0]!.headers)).not.toContain("authorization");
  expect(seen[0]!.headers["if-none-match"]).toBeUndefined();
});

test("a 304 revalidates the cache, and a channel switch is answered from it", async () => {
  let call = 0;
  const { feed, seen } = feedOver((_, init) => {
    call++;
    if (call === 1) return ok(NEXT_FIRST);
    expect((init.headers as Record<string, string>)["if-none-match"]).toBe('W/"abc"');
    return new Response(null, { status: 304 });
  });
  expect((await feed.latest("next"))?.version).toBe("0.2.0-next.10");
  expect((await feed.latest("next"))?.version).toBe("0.2.0-next.10");
  expect((await feed.latest("stable"))?.version).toBe("0.1.1");
  expect(seen).toHaveLength(3);
});

test("a changed ETag replaces the cache", async () => {
  let call = 0;
  const { feed } = feedOver(() =>
    ++call === 1 ? ok(NEXT_FIRST) : ok([release("v0.2.0"), ...NEXT_FIRST], { etag: 'W/"def"' }),
  );
  expect((await feed.latest("stable"))?.version).toBe("0.1.1");
  expect((await feed.latest("stable"))?.version).toBe("0.2.0");
});

test("stable follows the next page when the first has only pre-releases, at most MAX_PAGES", async () => {
  const page2 = "https://api.github.com/repositories/1/releases?per_page=100&page=2";
  const { feed, seen } = feedOver((url) => {
    if (url.includes("page=2")) return ok([release("v0.1.0")], { link: "" });
    return ok([release("v0.2.0-next.1"), release("v0.2.0-next.2")], {
      link: `<${page2}>; rel="next", <${page2}>; rel="last"`,
    });
  });
  expect((await feed.latest("stable"))?.version).toBe("0.1.0");
  expect(seen).toHaveLength(2);
  // Cached: no more requests than the revalidation.
  expect((await feed.latest("stable"))?.version).toBe("0.1.0");
  expect(MAX_PAGES).toBe(3);
});

test("a stable that never turns up stops after MAX_PAGES; links off the API host are not followed", async () => {
  const { feed, seen } = feedOver((url) => {
    const page = Number(/page=(\d+)/.exec(url)?.[1] ?? 1);
    return ok([release(`v0.2.0-next.${page}`)], {
      link: `<https://api.github.com/r?page=${page + 1}>; rel="next"`,
    });
  });
  expect(await feed.latest("stable")).toBeNull();
  expect(seen).toHaveLength(MAX_PAGES);

  const elsewhere = feedOver(() =>
    ok([release("v0.2.0-next.1")], { link: `<https://evil.example.test/x>; rel="next"` }),
  );
  expect(await elsewhere.feed.latest("stable")).toBeNull();
  expect(elsewhere.seen).toHaveLength(1);
});

test("rate limits carry the time GitHub gave", async () => {
  const reset = Math.floor(1_000_000 / 1000) + 600;
  const limited = feedOver(
    () =>
      new Response("{}", {
        status: 403,
        headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(reset) },
      }),
  );
  const error = await limited.feed.latest("next").catch((e: unknown) => e);
  expect(error).toBeInstanceOf(FeedRateLimited);
  expect((error as FeedRateLimited).until).toBe(reset * 1000);

  const retry = feedOver(
    () => new Response("{}", { status: 429, headers: { "retry-after": "90" } }),
  );
  expect(
    ((await retry.feed.latest("next").catch((e: unknown) => e)) as FeedRateLimited).until,
  ).toBe(1_000_000 + 90_000);

  const bare = feedOver(() => new Response("{}", { status: 429 }));
  expect(
    ((await bare.feed.latest("next").catch((e: unknown) => e)) as FeedRateLimited).until,
  ).toBeNull();
});

test("other failures are FeedErrors: status, network, bad JSON", async () => {
  const server = await feedOver(() => new Response("oops", { status: 500 }))
    .feed.latest("next")
    .catch((e: unknown) => e);
  expect(server).toBeInstanceOf(FeedError);
  expect(server).not.toBeInstanceOf(FeedRateLimited);
  expect((server as FeedError).status).toBe(500);

  const down = new GitHubReleaseFeed({
    fetch: (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch,
  });
  const network = (await down.latest("next").catch((e: unknown) => e)) as FeedError;
  expect(network.status).toBe(0);
  expect(network.message).toContain("ECONNREFUSED");

  const junk = await feedOver(() => new Response("<html>", { status: 200 }))
    .feed.latest("next")
    .catch((e: unknown) => e);
  expect((junk as FeedError).status).toBe(0);
});

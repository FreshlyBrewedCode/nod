/**
 * A fake GitHub behind an injectable `fetch`, for the GitHub source's tests:
 * it answers the source's GraphQL queries
 * (`Poll`, `Page`, `Details`, `SignTarget`, `Suggest`) from fixtures and
 * records every REST call (nod comments, reviews, 👀). It holds any number of
 * repos (`repo(name)`; fictional `acme/widgets` from the start, and the
 * fields of the old one-repo fake still reach that one). It plays one host
 * (github.com, `acme.ghe.com`, a GHES) and answers only that host's URL
 * shapes; anything else lands in `misdirected`. Two hosts are two fakes.
 */

import { githubHost, type GitHubHost } from "../../kit/host.ts";
import type { RawPr } from "./queries";
import { ALICE, REPO, iso, sha } from "./test-support";

export interface Recorded {
  readonly method: string;
  readonly path: string;
  readonly body: unknown;
  /** The GraphQL query's name, and its text. */
  readonly query?: string;
  readonly text?: string;
}

interface Canned {
  readonly status: number;
  readonly body: unknown;
  readonly headers?: Record<string, string>;
}

/** One repo of the fake host, with what its poll returns. */
export class FakeRepo {
  constructor(
    /** `owner/name`, as GitHub spells it. */
    readonly name: string,
  ) {}

  open: RawPr[] = [];
  closed: Array<{ number: number; updatedAt: string; closedAt: string; raw: RawPr }> = [];
  signers: string | null =
    `${ALICE} namespaces="nod" ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFakeFakeFakeFakeFakeFakeFakeFakeFakeFake\n`;
  /** `.nod/allowed_signers` at a head SHA. */
  headSigners = new Map<string, string>();
  files = { policy: true, verifier: true, workflow: true };
  rules: unknown[] = [
    { type: "pull_request", parameters: {} },
    {
      type: "required_status_checks",
      parameters: { required_status_checks: [{ context: "nod", integration_id: 15368 }] },
    },
  ];
  /** Set: reading the rules fails like this (a private repo on GitHub Free). */
  rulesError: { status: number; message: string } | null = null;
  autoMergeAllowed = true;
  viewerPermission = "ADMIN";
  epics = new Map<number, string>();
  /** What the search for `review-requested:@me` finds: PR numbers. */
  requested: number[] = [];
}

export class FakeGitHub {
  /** URLs called that are not this host's API (a test asserts there are none). */
  readonly misdirected: string[] = [];
  /** The host's repos by lowercase `owner/name`; `acme/widgets` is there from the start. */
  readonly repos = new Map<string, FakeRepo>();

  constructor(
    /** The host it plays (default github.com): every call must use its URL shapes. */
    readonly host: GitHubHost = githubHost("github.com"),
    /** The viewer's login on this host. */
    readonly login: string = ALICE,
  ) {
    this.repo(REPO);
  }

  /** A repo of the host, made on first use. */
  repo(name: string = REPO): FakeRepo {
    const k = name.toLowerCase();
    let r = this.repos.get(k);
    if (!r) this.repos.set(k, (r = new FakeRepo(name)));
    return r;
  }

  private find(owner: unknown, name: unknown): FakeRepo | null {
    return this.repos.get(`${String(owner)}/${String(name)}`.toLowerCase()) ?? null;
  }

  // The default repo's fields, as the single-repo tests use them.
  get open() {
    return this.repo().open;
  }
  set open(v: RawPr[]) {
    this.repo().open = v;
  }
  get closed() {
    return this.repo().closed;
  }
  set closed(v: FakeRepo["closed"]) {
    this.repo().closed = v;
  }
  get signers() {
    return this.repo().signers;
  }
  set signers(v: string | null) {
    this.repo().signers = v;
  }
  get headSigners() {
    return this.repo().headSigners;
  }
  get files() {
    return this.repo().files;
  }
  set files(v: FakeRepo["files"]) {
    this.repo().files = v;
  }
  get rules() {
    return this.repo().rules;
  }
  set rules(v: unknown[]) {
    this.repo().rules = v;
  }
  get rulesError() {
    return this.repo().rulesError;
  }
  set rulesError(v: FakeRepo["rulesError"]) {
    this.repo().rulesError = v;
  }
  get autoMergeAllowed() {
    return this.repo().autoMergeAllowed;
  }
  set autoMergeAllowed(v: boolean) {
    this.repo().autoMergeAllowed = v;
  }
  get epics() {
    return this.repo().epics;
  }
  get requested() {
    return this.repo().requested;
  }
  set requested(v: number[]) {
    this.repo().requested = v;
  }

  /** The token this host accepts; any other is "Bad credentials". */
  token = "t0ken";
  /** `output.text` by check run database id. */
  texts = new Map<number, string>();
  rateLimit = { cost: 2, remaining: 4900, limit: 5000, resetAt: iso(-60) };
  /** What the suggestion searches find: one repo name per open PR. */
  mine: string[] = [];
  asked: string[] = [];
  readonly calls: Recorded[] = [];
  /** Answers to send instead of the normal ones, in order (any request). */
  readonly failNext: Canned[] = [];
  /** Per REST route (`METHOD /path`): a canned answer. */
  readonly routes = new Map<string, Canned>();

  readonly fetch = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const href = String(input);
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    // The URL shapes of this host, and nothing else: GraphQL at its one
    // endpoint, REST under its API base (`/api/v3` on GHES).
    const restBase = `${this.host.apiUrl}/`;
    let url: URL;
    if (href.split("?")[0] === this.host.graphqlUrl) url = new URL("http://fake/graphql");
    else if (href.startsWith(restBase)) url = new URL(`http://fake/${href.slice(restBase.length)}`);
    else {
      this.misdirected.push(`${method} ${href}`);
      return json(421, { message: `not ${this.host.name}'s API: ${href}` });
    }
    const path = url.pathname + url.search;
    const auth = (init?.headers as Record<string, string>)?.authorization;
    if (auth !== `Bearer ${this.token}`) return json(401, { message: "Bad credentials" });
    if (path === "/graphql") {
      const query = String(body.query);
      const name = /query (\w+)/.exec(query)?.[1] ?? "?";
      this.calls.push({ method, path, body: body.variables, query: name, text: query });
      const fail = this.failNext.shift();
      if (fail) return json(fail.status, fail.body, fail.headers);
      const vars = (body.variables ?? {}) as Record<string, unknown>;
      if (name === "Poll") return json(200, this.poll(query, vars));
      if (name === "Page") return json(200, { data: this.page(vars) });
      if (name === "Details") return json(200, this.details(query, vars));
      if (name === "SignTarget") return json(200, { data: this.signTarget(vars) });
      if (name === "Suggest") return json(200, { data: this.suggest() });
      return json(200, { errors: [{ message: `unknown query ${name}` }] });
    }
    this.calls.push({ method, path, body });
    const fail = this.failNext.shift();
    if (fail) return json(fail.status, fail.body, fail.headers);
    const canned = this.routes.get(`${method} ${url.pathname}`);
    if (canned) return json(canned.status, canned.body, canned.headers);
    return this.rest(method, url.pathname, body);
  }) as typeof fetch;

  /** The GraphQL queries sent, by name. */
  queries(name?: string): Recorded[] {
    return this.calls.filter((c) => c.path === "/graphql" && (!name || c.query === name));
  }

  rests(): Recorded[] {
    return this.calls.filter((c) => c.path !== "/graphql");
  }

  private repoData(r: FakeRepo) {
    return {
      nameWithOwner: r.name,
      viewerPermission: r.viewerPermission,
      autoMergeAllowed: r.autoMergeAllowed,
      pushedAt: iso(5),
      defaultBranchRef: { name: "main", target: { oid: sha("main-tip") } },
      policy: r.files.policy ? { id: "B1" } : null,
      verifier: r.files.verifier ? { id: "B2" } : null,
      workflow: r.files.workflow ? { id: "B3" } : null,
      signers: r.signers === null ? null : { oid: "B4", text: r.signers },
      closed: {
        nodes: r.closed.map(({ number, updatedAt, closedAt }) => ({ number, updatedAt, closedAt })),
      },
      open: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: r.open },
    };
  }

  /** A host's poll: `r<i>`/`q<i>` per repo; a repo it does not have is null with an error. */
  private poll(query: string, vars: Record<string, unknown>) {
    const data: Record<string, unknown> = {
      rateLimit: this.rateLimit,
      viewer: { login: this.login, name: null },
    };
    const errors: unknown[] = [];
    for (const m of query.matchAll(/r(\d+): repository\(/g)) {
      const i = m[1]!;
      const r = this.find(vars[`o${i}`], vars[`n${i}`]);
      data[`r${i}`] = r ? this.repoData(r) : null;
      data[`q${i}`] = { nodes: (r?.requested ?? []).map((number) => ({ number })) };
      if (!r)
        errors.push({
          type: "NOT_FOUND",
          path: [`r${i}`],
          message: `Could not resolve to a Repository with the name '${String(vars[`o${i}`])}/${String(vars[`n${i}`])}'.`,
        });
    }
    return errors.length ? { data, errors } : { data };
  }

  private page(vars: Record<string, unknown>) {
    const r = this.find(vars.owner, vars.name);
    return {
      rateLimit: this.rateLimit,
      repository: r
        ? { open: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] } }
        : null,
    };
  }

  private details(query: string, vars: Record<string, unknown>) {
    const data: Record<string, unknown> = { rateLimit: this.rateLimit };
    const starts = [...query.matchAll(/d(\d+): repository\(/g)];
    for (const [k, m] of starts.entries()) {
      const i = m[1]!;
      const end = starts[k + 1]?.index ?? query.indexOf("texts: nodes(");
      const part = query.slice(m.index, end < 0 ? undefined : end);
      const r = this.find(vars[`o${i}`], vars[`n${i}`]);
      if (!r) {
        data[`d${i}`] = null;
        continue;
      }
      const repository: Record<string, unknown> = { id: `R_${r.name}` };
      for (const p of part.matchAll(/pr(\d+): pullRequest/g))
        repository[`pr${p[1]}`] = r.closed.find((c) => c.number === Number(p[1]))?.raw ?? null;
      for (const p of part.matchAll(/issue(\d+): issueOrPullRequest/g)) {
        const title = r.epics.get(Number(p[1]));
        repository[`issue${p[1]}`] = title ? { title } : null;
      }
      for (const p of part.matchAll(/(signers\d+): object\(expression: "([0-9a-f]+):/g))
        repository[p[1]!] = r.headSigners.has(p[2]!) ? { text: r.headSigners.get(p[2]!) } : null;
      data[`d${i}`] = repository;
    }
    const ids = /nodes\(ids: (\[[^\]]*\])\)/.exec(query);
    if (ids)
      data.texts = (JSON.parse(ids[1]!) as string[]).map((id) => {
        const databaseId = Number(/(\d+)$/.exec(id)?.[1]);
        return { id, databaseId, text: this.texts.get(databaseId) ?? null };
      });
    return { data };
  }

  private signTarget(vars: Record<string, unknown>) {
    const r = this.find(vars.owner, vars.name);
    const number = Number(vars.number);
    const pr =
      r?.open.find((p) => p.number === number) ?? r?.closed.find((c) => c.number === number)?.raw;
    return {
      repository: r
        ? {
            pullRequest: pr
              ? {
                  number,
                  state: pr.state,
                  isDraft: pr.isDraft,
                  merged: pr.merged,
                  author: pr.author,
                  baseRefName: pr.baseRefName,
                  headRefOid: pr.headRefOid,
                  baseRef: pr.baseRef,
                }
              : null,
          }
        : null,
    };
  }

  private suggest() {
    const hit = (name: string) => ({
      repository: { nameWithOwner: name, viewerPermission: "WRITE", pushedAt: iso(30) },
    });
    return {
      rateLimit: this.rateLimit,
      mine: { nodes: this.mine.map(hit) },
      asked: { nodes: this.asked.map(hit) },
    };
  }

  private comments = 0;
  private reviews = 0;

  private rest(method: string, path: string, body: unknown): Response {
    if (method === "GET" && path === "/user")
      return json(200, { login: this.login, name: null }, { "x-oauth-scopes": "repo, read:org" });
    const at = /^\/repos\/([^/]+)\/([^/]+)(\/.*)?$/.exec(path);
    const r = at ? this.find(at[1], at[2]) : null;
    if (!at || !r) return json(404, { message: `Not Found: ${method} ${path}` });
    const rest = at[3] ?? "";
    const web = `${this.host.webUrl}/${r.name}`;
    if (method === "GET" && rest === "") return json(200, { full_name: r.name, private: false });
    let m = /^\/issues\/(\d+)\/comments$/.exec(rest);
    if (method === "POST" && m)
      return json(201, { html_url: `${web}/pull/${m[1]}#issuecomment-${++this.comments}` });
    m = /^\/pulls\/(\d+)\/reviews$/.exec(rest);
    if (method === "POST" && m) {
      const id = ++this.reviews;
      return json(200, {
        id,
        state: (body as { event?: string }).event === "APPROVE" ? "APPROVED" : "COMMENTED",
        commit_id: (body as { commit_id?: string }).commit_id ?? null,
        html_url: `${web}/pull/${m[1]}#pullrequestreview-${id}`,
      });
    }
    m = /^\/issues\/(\d+)\/reactions$/.exec(rest);
    if (method === "POST" && m)
      return json(201, { content: (body as { content: string }).content });
    if (method === "GET" && rest === "/rules/branches/main")
      return r.rulesError
        ? json(r.rulesError.status, { message: r.rulesError.message })
        : json(200, r.rules);
    if (method === "GET" && rest === "/git/ref/heads/main")
      return json(200, { object: { sha: sha("main-tip") } });
    if (method === "GET" && rest === "/contents/.nod/allowed_signers")
      return json(200, {
        sha: "blob-sha",
        content: Buffer.from(r.signers ?? "").toString("base64"),
      });
    if (method === "POST" && rest === "/git/refs") return json(201, {});
    if (method === "PATCH" && rest.startsWith("/git/refs/heads/")) return json(200, {});
    if (method === "PUT" && rest === "/contents/.nod/allowed_signers") return json(200, {});
    if (method === "GET" && rest === "/pulls") return json(200, []);
    if (method === "POST" && rest === "/pulls")
      return json(201, { number: 77, html_url: `${web}/pull/77` });
    return json(404, { message: `Not Found: ${method} ${path}` });
  }
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

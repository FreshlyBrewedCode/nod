/**
 * A fake GitHub behind an injectable `fetch`, for the GitHub source's tests:
 * it answers the source's GraphQL queries (`Poll`, `Details`, `SignTarget`)
 * from fixtures and records every REST call. Fictional repo `acme/widgets`.
 */

import type { RawPr } from "./queries";
import { ALICE, REPO, iso, sha } from "./test-support";

export interface Recorded {
  readonly method: string;
  readonly path: string;
  readonly body: unknown;
  readonly query?: string;
}

interface Canned {
  readonly status: number;
  readonly body: unknown;
  readonly headers?: Record<string, string>;
}

export class FakeGitHub {
  open: RawPr[] = [];
  closed: Array<{ number: number; updatedAt: string; closedAt: string; raw: RawPr }> = [];
  /** `output.text` by check run database id. */
  texts = new Map<number, string>();
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
  rateLimit = { cost: 2, remaining: 4900, limit: 5000, resetAt: iso(-60) };
  epics = new Map<number, string>();
  readonly calls: Recorded[] = [];
  /** Answers to send instead of the normal ones, in order (any request). */
  readonly failNext: Canned[] = [];
  /** Per REST route (`METHOD /path`): a canned answer. */
  readonly routes = new Map<string, Canned>();

  readonly fetch = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    const path = url.pathname + url.search;
    const auth = (init?.headers as Record<string, string>)?.authorization;
    if (auth !== "Bearer t0ken") return json(401, { message: "Bad credentials" });
    if (path === "/graphql") {
      const query = String(body.query);
      const name = /query (\w+)/.exec(query)?.[1] ?? "?";
      this.calls.push({ method, path, body: body.variables, query: name });
      const fail = this.failNext.shift();
      if (fail) return json(fail.status, fail.body, fail.headers);
      if (name === "Poll") return json(200, { data: this.poll() });
      if (name === "Details") return json(200, { data: this.details(query) });
      if (name === "SignTarget") return json(200, { data: this.signTarget(body.variables.number) });
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

  private poll() {
    return {
      rateLimit: this.rateLimit,
      viewer: { login: ALICE, name: null },
      repository: {
        nameWithOwner: REPO,
        viewerPermission: "ADMIN",
        autoMergeAllowed: this.autoMergeAllowed,
        pushedAt: iso(5),
        defaultBranchRef: { name: "main", target: { oid: sha("main-tip") } },
        policy: this.files.policy ? { id: "B1" } : null,
        verifier: this.files.verifier ? { id: "B2" } : null,
        workflow: this.files.workflow ? { id: "B3" } : null,
        signers: this.signers === null ? null : { oid: "B4", text: this.signers },
        closed: {
          nodes: this.closed.map(({ number, updatedAt, closedAt }) => ({
            number,
            updatedAt,
            closedAt,
          })),
        },
        open: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: this.open },
      },
    };
  }

  private details(query: string) {
    const repository: Record<string, unknown> = { id: "R1" };
    for (const m of query.matchAll(/pr(\d+): pullRequest/g))
      repository[`pr${m[1]}`] = this.closed.find((c) => c.number === Number(m[1]))?.raw ?? null;
    for (const m of query.matchAll(/issue(\d+): issueOrPullRequest/g)) {
      const title = this.epics.get(Number(m[1]));
      repository[`issue${m[1]}`] = title ? { title } : null;
    }
    for (const m of query.matchAll(/(signers\d+): object\(expression: "([0-9a-f]+):/g))
      repository[m[1]!] = this.headSigners.has(m[2]!)
        ? { text: this.headSigners.get(m[2]!) }
        : null;
    const ids = /nodes\(ids: (\[[^\]]*\])\)/.exec(query);
    const texts = ids
      ? (JSON.parse(ids[1]!) as string[]).map((id) => {
          const databaseId = Number(/(\d+)$/.exec(id)?.[1]);
          return { id, databaseId, text: this.texts.get(databaseId) ?? null };
        })
      : undefined;
    return { rateLimit: this.rateLimit, repository, ...(texts && { texts }) };
  }

  private signTarget(number: number) {
    const pr =
      this.open.find((p) => p.number === number) ??
      this.closed.find((c) => c.number === number)?.raw;
    return {
      repository: {
        pullRequest: pr
          ? {
              number,
              state: pr.state,
              isDraft: pr.isDraft,
              merged: pr.merged,
              baseRefName: pr.baseRefName,
              headRefOid: pr.headRefOid,
              baseRef: pr.baseRef,
            }
          : null,
      },
    };
  }

  private comments = 0;

  private rest(method: string, path: string, body: unknown): Response {
    const repo = `/repos/${REPO}`;
    if (method === "GET" && path === "/user")
      return json(200, { login: ALICE, name: null }, { "x-oauth-scopes": "repo, read:org" });
    let m = new RegExp(`^${repo}/issues/(\\d+)/comments$`).exec(path);
    if (method === "POST" && m)
      return json(201, {
        html_url: `https://github.com/${REPO}/pull/${m[1]}#issuecomment-${++this.comments}`,
      });
    m = new RegExp(`^${repo}/issues/(\\d+)/reactions$`).exec(path);
    if (method === "POST" && m)
      return json(201, { content: (body as { content: string }).content });
    if (method === "GET" && path === `${repo}/rules/branches/main`)
      return this.rulesError
        ? json(this.rulesError.status, { message: this.rulesError.message })
        : json(200, this.rules);
    if (method === "GET" && path === `${repo}/git/ref/heads/main`)
      return json(200, { object: { sha: sha("main-tip") } });
    if (method === "GET" && path === `${repo}/contents/.nod/allowed_signers`)
      return json(200, {
        sha: "blob-sha",
        content: Buffer.from(this.signers ?? "").toString("base64"),
      });
    if (method === "POST" && path === `${repo}/git/refs`) return json(201, {});
    if (method === "PATCH" && path.startsWith(`${repo}/git/refs/heads/`)) return json(200, {});
    if (method === "PUT" && path === `${repo}/contents/.nod/allowed_signers`) return json(200, {});
    if (method === "GET" && path === `${repo}/pulls`) return json(200, []);
    if (method === "POST" && path === `${repo}/pulls`)
      return json(201, { number: 77, html_url: `https://github.com/${REPO}/pull/77` });
    return json(404, { message: `Not Found: ${method} ${path}` });
  }
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

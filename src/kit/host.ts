/**
 * The GitHub host a repository lives on, and the one place that knows the
 * shapes of its endpoints:
 *
 * | host                 | REST                        | GraphQL                             | web                     |
 * |----------------------|-----------------------------|-------------------------------------|-------------------------|
 * | `github.com`         | `https://api.github.com`    | `https://api.github.com/graphql`    | `https://github.com`    |
 * | `<name>.ghe.com`     | `https://api.<name>.ghe.com`| `https://api.<name>.ghe.com/graphql`| `https://<name>.ghe.com`|
 * | any other (GHES)     | `https://<host>/api/v3`     | `https://<host>/api/graphql`        | `https://<host>`        |
 *
 * Also here: the host and `owner/name` of a git remote URL
 * ({@link parseRemote}), and the rule that a host's token is sent to that
 * host's API only, never along a redirect to anywhere else
 * ({@link isApiUrl}, {@link fetchWithToken}).
 *
 * Pure apart from `fetch`; no Node APIs, so the web app uses it too.
 */

/** The host of GitHub.com. */
export const GITHUB_COM = "github.com";

/** Which kind of GitHub a host is. */
export type HostKind = "github.com" | "ghe.com" | "server";

/** A GitHub host and its endpoints. */
export interface GitHubHost {
  /** Lowercase host name, with `:port` when one was given: `github.com`, `acme.ghe.com`. */
  readonly name: string;
  /** `github.com`, GitHub Enterprise Cloud with data residency, or GitHub Enterprise Server. */
  readonly kind: HostKind;
  /** The web UI, no trailing slash: `https://acme.ghe.com`. */
  readonly webUrl: string;
  /** The REST API's base, no trailing slash. */
  readonly apiUrl: string;
  /** The GraphQL endpoint. */
  readonly graphqlUrl: string;
}

const LABEL = "[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?";
const HOST_RE = new RegExp(`^${LABEL}(?:\\.${LABEL})*(?::[1-9][0-9]{0,4})?$`);
const GHE_COM_RE = new RegExp(`^${LABEL}\\.ghe\\.com$`);

/**
 * The host name in `input`: a bare host (`acme.ghe.com`, `git.example.test:8443`)
 * or a server URL such as `GITHUB_SERVER_URL` (`https://acme.ghe.com/`).
 * Lowercased; null when it is not a host name.
 */
export function hostName(input: string): string | null {
  let s = input.trim().toLowerCase();
  const scheme = /^https?:\/\//.exec(s);
  if (scheme) {
    s = s.slice(scheme[0].length).replace(/\/+$/, "");
    if (s.includes("/") || s.includes("@")) return null;
  }
  if (!HOST_RE.test(s) || s.length > 253) return null;
  return s;
}

/**
 * The endpoints of a GitHub host (see the table above). `input` is a host
 * name or a server URL. Throws on anything that is not a host, and on names
 * that belong to GitHub.com or GHE.com without being a GitHub instance
 * (`api.github.com`, `gist.github.com`, `ghe.com`, `api.acme.ghe.com`).
 */
export function githubHost(input: string): GitHubHost {
  const name = hostName(input);
  if (!name) throw new Error(`not a GitHub host name: ${JSON.stringify(input)}`);
  if (name === GITHUB_COM)
    return {
      name,
      kind: "github.com",
      webUrl: "https://github.com",
      apiUrl: "https://api.github.com",
      graphqlUrl: "https://api.github.com/graphql",
    };
  if (GHE_COM_RE.test(name) && !name.startsWith("api."))
    return {
      name,
      kind: "ghe.com",
      webUrl: `https://${name}`,
      apiUrl: `https://api.${name}`,
      graphqlUrl: `https://api.${name}/graphql`,
    };
  const bare = name.replace(/:\d+$/, "");
  if (bare.endsWith(".github.com") || bare === "ghe.com" || bare.endsWith(".ghe.com"))
    throw new Error(
      `${name} is not a GitHub instance: use github.com, or <name>.ghe.com for GHE.com`,
    );
  return {
    name,
    kind: "server",
    webUrl: `https://${name}`,
    apiUrl: `https://${name}/api/v3`,
    graphqlUrl: `https://${name}/api/graphql`,
  };
}

/** The command that logs `gh` in to `host`: `gh auth login`, with `--hostname` off github.com. */
export function ghLoginCommand(host: string): string {
  const name = hostName(host) ?? host;
  return name === GITHUB_COM ? "gh auth login" : `gh auth login --hostname ${name}`;
}

/** Whether two host names (or server URLs) are the same host. */
export function sameHost(a: string, b: string): boolean {
  const x = hostName(a);
  return x !== null && x === hostName(b);
}

/** A git remote, read by {@link parseRemote}. */
export interface Remote {
  /** The host as the remote spells it, lowercased (ssh: without the port). */
  readonly host: string;
  /** `owner/name`, without `.git`. */
  readonly repo: string;
  /** Reached over ssh (`git@host:…`, `ssh://…`). */
  readonly ssh: boolean;
  /**
   * The host looks like an alias from an ssh config (`git@work:acme/x`,
   * `git@github.com-work:acme/x`): it cannot be resolved without reading
   * `~/.ssh/config`, so the host has to be given (`--host`).
   */
  readonly alias: boolean;
}

/** An owner (user or organization login, managed users included). */
const OWNER = "[A-Za-z0-9][A-Za-z0-9_-]{0,38}";
/** A repository name. */
const NAME = "[A-Za-z0-9._-]{1,100}";
const PATH_RE = new RegExp(`^/?(${OWNER})/(${NAME}?)(?:\\.git)?/*$`);

/**
 * The host and `owner/name` of a git remote URL, in every spelling git
 * accepts for a GitHub remote: `https://host[:port]/owner/repo(.git)`,
 * `ssh://user@host[:port]/owner/repo`, `user@host:owner/repo.git`,
 * `git://host/owner/repo`, with or without a trailing slash. null for local
 * paths, `file://` and anything else.
 */
export function parseRemote(url: string): Remote | null {
  const s = url.trim();
  let host: string;
  let path: string;
  let ssh: boolean;
  const withScheme = /^(https?|ssh|git\+ssh|ssh\+git|git):\/\/(?:[^@/]*@)?([^/]+)(\/.*)$/i.exec(s);
  if (withScheme) {
    const scheme = withScheme[1]!.toLowerCase();
    ssh = scheme.includes("ssh");
    host = withScheme[2]!.toLowerCase();
    // The ssh or git port is not the web's; an https port is part of the host.
    if (ssh || scheme === "git") host = host.replace(/:\d+$/, "");
    path = withScheme[3]!;
  } else {
    // scp-like: [user@]host:owner/repo. A `/` before the colon makes it a path.
    const scp = /^(?:[^@/:]+@)?([^/:]+):(?!\/\/)(.+)$/.exec(s);
    if (!scp) return null;
    ssh = true;
    host = scp[1]!.toLowerCase();
    path = scp[2]!;
  }
  const m = PATH_RE.exec(path);
  if (!m || m[2] === "." || m[2] === ".." || !m[2]) return null;
  const valid = HOST_RE.test(host);
  const alias = ssh && (!valid || !host.includes(".") || /^github\.com.|\.ghe\.com./.test(host));
  if (!valid && !alias) return null;
  return { host, repo: `${m[1]}/${m[2]}`, ssh, alias };
}

/**
 * Whether `url` is one of `host`'s API endpoints: the only URLs a token of
 * that host may be sent to. https only, no credentials in the URL; on
 * GitHub Enterprise Server only the `/api/` paths.
 */
export function isApiUrl(host: GitHubHost, url: string): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.protocol !== "https:" || u.username || u.password) return false;
  if (u.host !== new URL(host.apiUrl).host) return false;
  if (host.kind !== "server") return true;
  return (
    u.pathname === "/api/graphql" || u.pathname === "/api/v3" || u.pathname.startsWith("/api/v3/")
  );
}

/** Thrown by {@link fetchWithToken} instead of sending a token where it does not belong. */
export class TokenHostError extends Error {
  override name = "TokenHostError";
}

/**
 * `fetch` with a bearer token, bound to where the token belongs: every URL,
 * the first and each redirect's, must pass `allowed` (normally
 * {@link isApiUrl} of the token's host), or this throws
 * {@link TokenHostError} without sending anything. Redirects are followed by
 * hand (`redirect: "manual"`), at most `maxRedirects`, so the token never
 * travels along a redirect to another host.
 */
export async function fetchWithToken(
  url: string,
  init: RequestInit & { headers?: Record<string, string> },
  options: {
    token: string;
    allowed: (url: string) => boolean;
    fetch?: typeof fetch;
    maxRedirects?: number;
  },
): Promise<Response> {
  const doFetch = options.fetch ?? fetch;
  let current = url;
  let method = init.method ?? "GET";
  let body = init.body;
  for (let hop = 0; ; hop++) {
    if (!options.allowed(current))
      throw new TokenHostError(
        `refusing to send the token to ${safeOrigin(current)}: it belongs to another host`,
      );
    const res = await doFetch(current, {
      ...init,
      method,
      body,
      redirect: "manual",
      headers: { ...init.headers, authorization: `Bearer ${options.token}` },
    });
    const location = res.headers.get("location");
    if (res.status < 300 || res.status > 399 || res.status === 304 || !location) return res;
    if (hop >= (options.maxRedirects ?? 3)) throw new TokenHostError("too many redirects");
    current = new URL(location, current).toString();
    if (res.status === 303 || ((res.status === 301 || res.status === 302) && method === "POST")) {
      method = "GET";
      body = undefined;
    }
  }
}

function safeOrigin(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return "a malformed URL";
  }
}

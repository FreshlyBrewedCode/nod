/**
 * A repo's identity on the wire and in the web app (ADR 0007, 6): the repo
 * key, `owner/name` on github.com and `host/owner/name` on any other host,
 * the same convention as deep links. A PR is (repo key, number); the web
 * app names it by one string, the PR id `<repo key>#<n>`.
 *
 * The host is lowercase (`hostName`); `owner/name` is spelled as GitHub
 * returns it. Keys compare case-insensitively (`sameRepo`).
 */

import { GITHUB_COM, hostName } from "../kit/host.ts";

/** `owner/name` on github.com, `host/owner/name` elsewhere: `tallyho/fieldbook`, `acme.ghe.com/finance/ledger`. */
export type RepoKey = string;

/** `<repo key>#<n>`: `tallyho/fieldbook#482`. */
export type PrId = string;

const NAME = /^[\w.-]+$/;

/** The key of `owner/name` on `host` (a host name, any case; github.com is left out). */
export function repoKey(host: string, name: string): RepoKey {
  const h = hostName(host) ?? host.toLowerCase();
  return h === GITHUB_COM ? name : `${h}/${name}`;
}

/** The host and `owner/name` of a key; null when it is not one. */
export function parseRepoKey(key: string): { readonly host: string; readonly name: string } | null {
  const parts = key.split("/");
  if (parts.length !== 2 && parts.length !== 3) return null;
  const host = parts.length === 3 ? hostName(parts[0]!) : GITHUB_COM;
  const [owner, repo] = parts.slice(-2) as [string, string];
  if (!host || !NAME.test(owner) || !NAME.test(repo)) return null;
  return { host, name: `${owner}/${repo}` };
}

const OWNER = /^[A-Za-z0-9][A-Za-z0-9_-]{0,38}$/;
const REPO = /^[A-Za-z0-9._-]{1,100}$/;

/** `owner/name` from two path segments (`.git` dropped); null when they are none. */
function nameOf(owner: string | undefined, repo: string | undefined): string | null {
  const name = repo?.replace(/\.git$/i, "");
  if (!owner || !name || !OWNER.test(owner) || !REPO.test(name)) return null;
  if (name === "." || name === "..") return null;
  return `${owner}/${name}`;
}

/** An ssh remote's host; null for what looks like an alias from an ssh config (`git@work:…`). */
function sshHost(host: string): string | null {
  const name = hostName(host);
  return name && name.includes(".") && !/^github\.com.|\.ghe\.com./.test(name) ? name : null;
}

/**
 * A repo as a person names it when adding one (ADR 0007, 2): `owner/name`
 * (github.com), `host/owner/name`, or a link to the repo or anything in it
 * (`https://acme.ghe.com/finance/ledger/pull/57`, a clone URL, `git@host:owner/name.git`).
 * The host is lowercased (`hostName`); null when it names no repo. Whether
 * the repo exists is the server's to find out.
 */
export function parseRepoInput(
  input: string,
): { readonly host: string; readonly name: string; readonly key: RepoKey } | null {
  const s = input.trim().replace(/\/+$/, "");
  if (!s || s.length > 300 || /\s/.test(s)) return null;
  const result = (host: string | null, name: string | null) =>
    host && name ? { host, name, key: repoKey(host, name) } : null;
  // A link: https://host/owner/name[/…], or a remote git accepts.
  const url = /^(?:https?|ssh|git):\/\/(?:[^@/]*@)?([^/]+)\/([^/?#]+)\/([^/?#]+)/i.exec(s);
  if (url) {
    const ssh = !/^https?:/i.test(s);
    const host = ssh ? sshHost(url[1]!.replace(/:\d+$/, "")) : hostName(url[1]!);
    return result(host, nameOf(url[2], url[3]));
  }
  const scp = /^[^@/:\s]+@([^/:]+):([^/]+)\/([^/]+)$/.exec(s);
  if (scp) return result(sshHost(scp[1]!), nameOf(scp[2], scp[3]));
  const parts = s.split("/");
  if (parts.length === 2) return result(GITHUB_COM, nameOf(parts[0], parts[1]));
  if (parts.length === 3) return result(hostName(parts[0]!), nameOf(parts[1], parts[2]));
  return null;
}

/** Two keys name the same repo (case does not matter on GitHub). */
export function sameRepo(a: RepoKey | null | undefined, b: RepoKey | null | undefined): boolean {
  return a != null && b != null && a.toLowerCase() === b.toLowerCase();
}

/** The PR id of a PR: `tallyho/fieldbook#482`. */
export function prId(repo: RepoKey, number: number): PrId {
  return `${repo}#${number}`;
}

/** The id of anything that carries its repo and number (a `PrView`, an `UnclassifiedPr`). */
export const idOf = (pr: { readonly repo: RepoKey; readonly number: number }): PrId =>
  prId(pr.repo, pr.number);

/** The repo and number of a PR id; null when it is not one. */
export function parsePrId(id: string): { readonly repo: RepoKey; readonly number: number } | null {
  const cut = id.lastIndexOf("#");
  if (cut < 0) return null;
  const number = Number(id.slice(cut + 1));
  const repo = id.slice(0, cut);
  if (!Number.isInteger(number) || number <= 0 || !parseRepoKey(repo)) return null;
  return { repo, number };
}

/**
 * The repo chip's words for each repo of a list: the shortest name that
 * still tells them apart. `ledger`; `finance/ledger` when two repos share
 * the name; the whole key when even that is shared (the same `owner/name`
 * on two hosts).
 */
export function chipLabels(keys: ReadonlyArray<RepoKey>): ReadonlyMap<RepoKey, string> {
  const parsed = keys.map((key) => ({ key, ...(parseRepoKey(key) ?? { host: "", name: key }) }));
  const count = (f: (p: (typeof parsed)[number]) => string) => {
    const n = new Map<string, number>();
    for (const p of parsed) n.set(f(p).toLowerCase(), (n.get(f(p).toLowerCase()) ?? 0) + 1);
    return (p: (typeof parsed)[number]) => n.get(f(p).toLowerCase()) ?? 0;
  };
  const short = (p: (typeof parsed)[number]) => p.name.split("/")[1] ?? p.name;
  const byShort = count(short);
  const byName = count((p) => p.name);
  return new Map(
    parsed.map((p) => [p.key, byShort(p) === 1 ? short(p) : byName(p) === 1 ? p.name : p.key]),
  );
}

# 0007: Many repositories

Status: accepted (2026-11-27), from the owner's second brainstorm ([concept](../concept.md), "Opening up", part C), written with #47; the open questions there were decided in the epic's spirit and are listed in its pull request. Replaces the concept's "Scope v1: one repo" (Product, 1), the `Welcome`'s single `repo` and `setup` (protocol 1), and the "this repo" wording of [ADR 0006](0006-opt-in-ladder.md) §7 (the offers are now per repo). The nod payload of [ADR 0001](0001-nod-format-and-validity.md) is unchanged. Epic #46.

## Context

`nod serve` read one repository: the clone it was started in. A person who works across a few repos ran one server per repo, paired a browser with each, and had as many inboxes. The ladder (ADR 0006) made nod useful in a repo that has nothing of nod in it, which makes "all the repos I work in" the natural inbox. Each of those repos is at its own step of the ladder, may be on another GitHub host, and trusts its own list of keys.

## Decision

1. **One server, many repos, one inbox.** One `nod serve` reads every repo of its list into one snapshot. With one repo the dashboard looks as it always did: the repo's name in the top bar, no chip on the rows. With several, the top bar names none and every row carries a **repo chip** (the shortest name that tells the repos apart: `ledger`, else `owner/ledger`, else the repo key). A repo filter and grouping the board by repo follow (#49).

2. **The repo list** lives in `$XDG_CONFIG_HOME/nod/config.json` (else `~/.config/nod/`), next to the key file:

   ```json
   { "nod": "config", "version": 1,
     "repos": [{ "host": "github.com", "repo": "tallyho/fieldbook" },
               { "host": "acme.ghe.com", "repo": "finance/ledger" }] }
   ```

   - Versioned; the reader is tolerant (unknown fields are kept on rewrite, an entry it cannot read is skipped and named in the log, never dropped from the file); writes go through a temp file and a rename in the same directory.
   - Managed from the settings page (#49) and `nod repo add <[host/]owner/name> | remove | list` (#48). Adding suggests repos where I have open pull requests or review requests: one search per host.
   - The list's order is the inbox's order wherever one is needed (the offer card, the setup page's default).
   - `--dir <clone>` (default: the folder `nod serve` starts in, when it is a clone and the list is empty) stays as an override: it serves that one clone, as before, and never writes the list.

3. **nod keeps its own clones.** For a repo of the list, nod makes a blobless bare clone (`git clone --bare --filter=blob:none`, argument arrays, never a shell) under `$XDG_CACHE_HOME/nod/clones/<host>/<owner>/<repo>.git` (else `~/.cache/nod/`), on `nod repo add` or on the first poll that needs a patch-id. Patch-ids are computed there as today: the base tip and the head fetched by id into `refs/nod/base` (`fetchPullRequestObjects`), the token passed for that host's URL only, never written into the clone's config. It is a cache: deleting the folder costs a clone, nothing else. A `--dir` clone is used as it is.

4. **Hosts side by side.** github.com, `<name>.ghe.com` and GitHub Enterprise Servers can be in one list. Each host has its own token (`gh auth token --hostname <host>`), its own `GitHubApi` and its own rate limit, and a token goes to its own host only (`fetchWithToken`, redirects included; `src/kit/host.ts` stays the only place that knows the URL shapes). A host without a `gh` login shows that host's sign-in command on its repos; the other hosts work.

5. **One GraphQL query per host per poll**: one block per repo (aliases `r0`, `r1`, …) in the same query, so ten repos on github.com cost one request and one budget read. `NOD_DEBUG=1` logs each host's query, cost and time. The snapshot's `sync` stays one status: the oldest successful read, a failing host's message (naming the host), and a rate limit's `until`.

6. **A repo's identity is its repo key**, one string used everywhere, on the wire and in the web app:
   - `owner/name` on github.com, `host/owner/name` on any other host: the same convention as deep links (`#/pr/<owner>/<repo>/<n>`, `#/pr/<host>/<owner>/<repo>/<n>`), so a key is also how a repo is named on screen. Two hosts with an `acme/api` each are two keys.
   - The host is lowercase, as `hostName` normalizes it; `owner/name` is spelled as GitHub returns it (`nameWithOwner`); keys are compared case-insensitively. `src/shared/repo-key.ts` builds and parses them.
   - A **PR's identity is (repo key, number)**. Requests carry both. In the web app a PR id is the string `<repo key>#<n>` (selection, focus, the batch, React keys); it is also the key the "opened" marks were stored under, so they carry over.
   - Why a string and not `{ host, owner, name }`: it is a map key, a route segment and a storage key as it stands, and comparing two of them cannot miss a field.

7. **Protocol 2.** `PROTOCOL_VERSION` is 2; a web app and a server of different versions do not talk, and the web app says which one to update, calmly, on a full page.
   - `welcome` carries `repos: RepoInfo[]` (key, `owner/name`, the `GitHubInfo` of its host, its `SetupStatus` with the ladder step, and my key's enrolment there) instead of `repo`, `github` and `setup`. An empty list is "no repo yet" (the fake's first run); `SetupStatus` loses its `repo` and the state `none`.
   - The `setup` push becomes `repos`, the whole list, on every change of a repo's setup, my enrolment in one, or the list itself (#48).
   - `KeyInfo.enrolment` moves to `RepoInfo.enrolment`: the `signer` push is the key and its lock state only.
   - The snapshot holds every repo's PRs and loses `repo`; each `PrView` and `UnclassifiedPr` carries its repo key. `dependsOn` and `unblocks` stay numbers in the PR's own repo: a brief's `Depends on #n` and a stacked base branch can only name a PR of the same repo.
   - `sign` and `approve` entries are `{ repo, pr, head_sha }`; `ack-fyi`, `check-setup`, `open-setup-pr` and `open-enrol-pr` take a `repo`; results and `stale` details name the repo of each PR. `test-signature` no longer answers an enrolment (it is per repo). `list-repos` and `pick-repo` stay for the fake's first run; #48 brings the requests that add, remove and suggest repos.
   - Fields that were added to protocol 1 as optional (`SetupStatus.step`, `.permission`, the host) are required now.
   - **Later additions stay inside protocol 2**: epic D's server, service and update state and epic B's insights per PR arrive as new optional fields or new pushes, which an older page ignores. The version moves only when a field changes its meaning or goes away.

8. **The `Source` seam: one source that knows many repos.** Every source method that touches a repo takes its key; `repos()` lists them; `snapshot()` is all of them. The session stays a thin layer over it: it checks requests, groups a batch by repo, signs, and asks the source per repo.
   - Rejected: one source per repo, combined by the session. The GitHub side must ask once per host per poll (5), and tokens, accounts and rate limits are per host, so per-repo sources would each poll, or need a shared poller under them, which is the multi-repo source again behind one more seam.
   - Inside a source the per-repo part may stay a class of its own: the fake has a `FakeRepo` per repo; the GitHub source keeps its one-repo body per repo under a per-host poller (#48). Until then the GitHub source reads its one repo and presents it as a list of one.
   - A login is per host: `welcome.me` is the account of the first repo's host, and every `PrView` is already relative to its own host's login (`mine`, `needsMe`, the ask). Should someone's logins differ between hosts, #48 adds the login to `RepoInfo`.

9. **One key, enrolled per repo.** There is one signing key per machine (ADR 0004) and one unlock window per side (ADR 0005) for every repo; each repo's `.nod/allowed_signers` is its own trust root (ADR 0002), so my key's enrolment is per repo. What a PR asks of me follows the enrolment in its repo: an active key signs; elsewhere it is a GitHub approval where one counts (ADR 0006). The setup and key offers, and the setup page's steps, are per repo. The lock chip is the key's: it shows "pending" or "not enrolled" only when the key signs in none of the repos.

10. **A batch may span repos: one signature per repo.** The payload names one repo (ADR 0001), so a nod batch across repos signs one payload per repo, each with that repo's entries, in one go (`Signer.signLines`: an unlock "just this once" covers the whole batch), and posts each repo's comment on that repo's PRs. The dialog shows one batch; its sentence says "one signature per repository" and the exact payloads are listed per repo.
    - All or nothing across repos, as within one: every repo's enrolment is checked and every entry's head compared before anything is signed; a moved head anywhere signs nothing anywhere.
    - Approvals likewise: one `approve` request, an approval per PR, each posted to its repo's host.
    - A batch is one kind, nods or approvals (#59): with many repos a batch can meet both, and a row of the other kind stays in view and waits for a batch of its own.
    - **Known limit.** The payload names `owner/name`, not the host. If one key is enrolled in two repos of the same name on two hosts, a nod copied from one onto the other's PR of the same number, base and content counts there too. It takes the same content and a real nod by that person; a payload version 2 naming the host, checked by the repo-owned verifier, closes it if it ever matters.

11. **Offers with many repos.** Still one calm card above the list: the next step of the first repo, in the list's order, that has one; it names its repo when there are several. Dismissing it shows no other card (ADR 0006 §7: the ladder waits); the avatar menu lists every repo's offers, each with its repo. The setup page takes the repo in its route, `#/setup/<repo key>/<step>`; without one it opens on the card's repo, else the first. With several repos it names the repo and lets me switch. #49 moves this into the settings page.

## Consequences

- One browser pairing, one unlock, one inbox for all of a person's repos.
- `nod serve` writes a cache under `$XDG_CACHE_HOME/nod/` (clones) and a config file under `$XDG_CONFIG_HOME/nod/`; tests use temp XDG dirs, never the real ones.
- A web app of protocol 1 (the hosted UI before this release) and a server of protocol 2 do not talk; each says so on a full page. The hosted UI follows the CLI's channel (`src/server/web-url.ts`), so a matching pair is the usual case.
- A poll costs one request per host, not per repo; a GraphQL query grows with the repos in it, and the cost is logged.
- Not built here (#47): the config file, the clones, `nod repo`, polling several repos or hosts. The fake (`--scenario repos`: three repos at three ladder steps, one on `acme.ghe.com`) and the web app work with many repos; the GitHub source is one repo in a list of one until #48.

# 0009: Your own inbox: the personal layer

Status: accepted (2026-11-27), from the owner's second brainstorm ([concept](../concept.md), "Opening up", part B). Adds a layer next to the policy; supersedes nothing. Epic #55; the kit's half is #56, the runner #57, the UI #58.

## Context

The policy (`.nod/policy.ts`, run by the verifier) decides a PR's risk and what it needs before it may merge. It is shared, reviewed and gating, so it is the wrong place for what only I care about: "anything under `src/auth/` is mine to look at", "don't show me Renovate", "this PR touches files of my own open PR", "how much of this diff is tests". Today the only way to say any of that is to change the repo's policy, which changes it for everyone and goes through a peer's nod.

The owner wants this to be "a powerful concept in general": one person writes a ten-line analyzer and sees its result in the panel, without asking the repo.

## Decision

1. **Two layers.** The **repo layer** (the policy, run by the verifier, or by `nod serve`'s built-in policy at the inbox step, ADR 0006 decision 6) decides **risk and the requirement**: shared, gating. The **personal layer** (mine, run only by my `nod serve`) decides **how much of my attention** a PR gets and **what I should know** about it.
   - The personal layer **never changes the repo's risk or requirement**, and nothing it says reaches GitHub. Its output is a separate value (`PersonalAttention`, the insights), never a `Finding` with a `risk`: there is no field through which it could raise or lower risk.
   - The panel keeps them apart, in words: "repo: high risk" vs "you: watching auth".
   - **It cannot hide what the repo asks of me.** The adjustment moves a PR one tier and `mute` folds it into Background, but a PR that needs my nod or approval stays in the "needs me" tiers, and an open high-risk PR is still never folded (concept decision 11). `attention.ts` (#57) applies the adjustment inside those rules.

2. **Configuration lives with me, not in a repo:** `$XDG_CONFIG_HOME/nod/inbox/`, written by `nod inbox init` (#57): `inbox.ts`, `analyzers/`, and a `package.json` pinning `@frebreco/nod` so the editor has the types.
   - `inbox.ts` default-exports one `defineInbox({ classifiers, analyzers, repos })`. No file: the built-in defaults run. With a file: exactly what it lists; `...defaults().classifiers` and `...defaults().analyzers` keep them.
   - `repos` adds classifiers and analyzers for some repositories only, keyed by `owner/name` or a glob (`acme/*`). It only adds; to leave something out for a repo, the part checks `ctx.pr.repo` itself.
   - `defineInbox` checks what it can at load time (analyzer ids well-formed and unique, every entry the right shape) and throws, which the runner shows as a load error.

3. **One import, its own entry: `@frebreco/nod/kit/inbox`.** The verifier's kit (`@frebreco/nod/kit`) stays as it is: its surface is what a repo's verifier pins, and nothing here concerns it. The sub-entry has its own `INBOX_VERSION`. Its modules split into **pure** ones (types, block constructors, validators, the limited markdown, the defaults, the composition) that import nothing from Node, so the web app can import the types and `parseInsight` by path, and **one** module that spawns `git` (`git-io.ts`).

4. **Attention classifiers** have the kit's `Classifier` shape: a plain function from a context to a list, sync or async. They output a **fixed vocabulary**, an `AttentionMark`:
   - `attention`: `+1`, `-1` or `"mute"`; `tag`: a short word the row shows quietly; `fyi`: worth knowing about; `detail`: one sentence, the reason.
   - A mark says at least one of `attention`, `tag` or `fyi`; one that says none is dropped.
   - **Combining:** `mute` wins over everything (it is the most explicit thing a person says); otherwise the `+1`s and `-1`s add up and the sum is clamped to one tier either way. Tags are deduplicated; `fyi` if any mark says so. Every mark is kept with its classifier's name, for the panel's reasons.
   - A classifier that throws adds an error and nothing else. Unlike the repo layer, the personal layer does not fail safe by raising attention: a broken personal classifier must not make every PR look urgent.
   - A classifier is named for the marks by `classifier("name", fn)`, or after the function.
   - Built-ins: `overlapsMyWork()` (+1 when someone else's PR touches files of my open PRs), `watch(globs, { attention, tag })`, `mute({ authors, paths, labels })` (paths only when **every** changed file matches, so a PR that also touches something else is not muted), and `briefMismatch()` (+1 when the brief's declared risk is two or more levels below what the repo layer says; a tag when the brief's "Look at" names paths the PR does not touch).

5. **Analyzers return insights**: an optional title and summary, and **typed blocks**: `breakdown` (a stacked bar by default, `style: "donut"` optional), `stats`, `series` (bars or a line), `files`, `text` (limited markdown). **Never HTML or SVG.**
   - Why: an insight is drawn inside the panel that also holds the sign button. HTML from personal code would be a script-injection surface in the one page that can sign, and SVG is HTML with extra steps. Typed blocks keep the look consistent (the r3 tokens, one renderer per block, the phone layout) and let `nod inbox test` print the same insight in a terminal.
   - **Colours are semantic slots, never CSS:** `tone` is one of `neutral`, `muted`, `info`, `good`, `warn`, `bad` (meaning), or `c1`…`c6` (series slots that only need to be told apart). The web app maps them to its theme tokens; anything else is dropped.
   - **Limited markdown** in `text`: paragraphs, `-` lists, `**bold**`, `*italic*`, `` `code` ``, and `[links](https://…)` to `http(s)` only. Everything else, HTML included, is shown as text. The kit parses it (`parseMarkdown`) into a small tree, so the web app renders nodes, never a string as HTML.
   - **Plain JSON with a validator.** Blocks cross a process boundary and the wire, so they are plain data, and `parseInsight` / `parseAttention` rebuild them from `unknown`: unknown block types and malformed blocks are dropped, non-finite numbers are dropped, strings are trimmed of control characters and cut, and the counts are capped (`INSIGHT_LIMITS`: 8 blocks, 50 files, 12 breakdown parts, 8 stats, 120 series points, 4000 characters of text). A buggy analyzer can produce an empty insight, never a broken panel.
   - Strings lose control characters and bidi overrides (which could reorder what a row shows); a PR reference in a `files` item is a number and an `owner/name`, never a URL, so the web app builds the link itself.
   - Small constructors make an analyzer short: `insight(stats([...]), files([...]))`, and `defineAnalyzer({ id, title, when, run(ctx) { … } })`. `run` may return an insight, a block, a list of blocks, or nothing (the insight is then hidden).

6. **The context** (`InboxContext`) is what a repo classifier gets (`pr`, `files`, `readBaseFile`), plus:
   - `diff(paths?)`: the unified diff from the merge base to the head, with the patch-id's pinned flags, optionally for some paths only;
   - `readHeadFile(path)`: the file as the PR has it. The PR's author wrote it: use it to show, never to trust;
   - `git(args)`: read-only git in the clone. The first argument must be one of an allow-list of read-only subcommands (`log`, `show`, `diff`, `diff-tree`, `rev-list`, `rev-parse`, `merge-base`, `cat-file`, `ls-tree`, `blame`, `shortlog`, `describe`, `name-rev`, `for-each-ref`, `show-ref`, `grep`), and options that write files, run programs or read outside the repo (`--output`, `--ext-diff`, `--textconv`, `--filters`, `--no-index`, `--contents`, `--open-files-in-pager`, `-O`, `--exec`, `--upload-pack`, `--git-dir`, `--work-tree`) are refused, and so is any unique prefix of one, since git accepts `--outp=x` for `--output=x` (`--text` and `--filter` are real options and allowed). Argument arrays, never a shell; the kit's `gitEnv`, `--attr-source` at the empty tree (no attribute from a PR can switch on a filter or a textconv), no pager, a timeout (30 s) and an output cap (16 MiB). `ctx.revs` names the base tip and the head for it;
   - `me` (my login), `myWork` (my open PRs and their files) and `repoSummary` (the repo layer's result for this PR: source, risk, category, tags, whether it is satisfied, or `null`).
   - Both classifiers and analyzers get the same context: one thing to learn. Its I/O is an interface (`InboxIO`) with the real implementation over a git clone (`gitInboxIO`) and a test double (`fakeInboxIO`), so a user can test an analyzer without a clone.
   - **Reads are lazy.** nod's own clones are blobless and bare (`--filter=blob:none`, epic C): trees and history are there, file contents are fetched on first read. `readBaseFile`, `readHeadFile`, `diff` and a `git` that prints contents (`show`, `log -p`, `blame`) may fetch from the host; `log --name-only`, `ls-tree` and `rev-list` never do. The defaults are written that way: `diffComposition` diffs only code and test files and takes the rest from the file list.

7. **When an analyzer runs.** Each declares `when: "poll"` (after a poll, for PRs whose head changed: cheap ones) or `when: "open"` (when the panel opens on the PR: expensive ones). Classifiers always run on poll, since the list needs them.
   - **Results are cached by analyzer and patch-id** (`insightCacheKey`): a rebase that keeps the patch-id keeps the insight. An analyzer whose result depends on more than the diff adds to its key with `cacheKey(ctx)`; `overlapsMyWork` keys on my open PRs' files. Reloading `inbox.ts` drops the cache of "yours".
   - `nod inbox test` prints the same result through `formatAttention` and `formatInsightState`; `runInbox` runs one PR's classifiers and analyzers in order.
   - Each result is an `InsightState`: `ready` (with the insight), `empty`, `running` or `failed` (with the error), labelled `default` (from `defaults()`) or `yours`. The kit's `runAnalyzer` produces all of them but `running`, which only the runner knows.

8. **Isolation: a subprocess, not a sandbox.** Personal code runs in a subprocess of `nod serve` that speaks **JSON lines over stdio** (one request or result per line), with a **timeout per analyzer** (the kit's default is 10 s for `poll`, 60 s for `open`); a hung process is killed and restarted (#57).
   - It never gets the signing key or the socket token: its environment is scrubbed and it holds no handle to the server.
   - Everything that comes back is re-validated on the server's side with `parseInsight` / `parseAttention`, whatever the subprocess claims.
   - **It is not a sandbox against the user's own code.** `inbox.ts` runs as the user, with the user's files and network, the same as any script they run. The subprocess protects `nod serve` from a crash, a hang or a memory leak in personal code, and keeps the key out of its address space. The docs say so in those words.

9. **No LLM analyzer in v1; the API stays open for one.** A later `llmSummary()` is an ordinary `when: "open"` analyzer that calls a CLI the user already has (with the diff on stdin) and returns a `text` block. Nothing here prevents it: analyzers are async, run in the subprocess with a timeout, and the `open` timeout leaves it room. It is left out because the first version should prove the blocks with deterministic analyzers.

10. **The defaults** (`defaults()`): classifiers `overlapsMyWork()` and `briefMismatch()`; analyzers `diffComposition()`, `hotspots({ days: 30 })` and the insight of `overlapsMyWork()`. `familiarity()` ships off.
    - `overlapsMyWork()` is one value that is both a classifier and an analyzer, so it goes in both lists under one name.
    - `diffComposition()` (`poll`): changed lines as code, tests, docs, comments, config and generated, as a breakdown. Files are sorted by path (generated: the kit's `DIFF_SIZE_IGNORE`; then tests, docs, config by globs); comments are found in code and test files line by line from the unified diff, by per-language rules chosen by extension or file name (`//`, `#`, `--`, `;`, `%`, `/* */`, `<!-- -->`, `{- -}`, Lua's `--[[ ]]`, Python docstrings), following block comments through each hunk's context lines. No parser: a line with code and a trailing comment is code, and a block comment that starts above a hunk is guessed from a leading `*`. Blank lines are not counted.
    - Paths given to `diff` are literal pathspecs, so a file named `:(top)x` is a name, not magic.
    - `hotspots({ days: 30 })` (`poll`): which touched files changed most often on the base in the last days (`git log --since --name-only`, no file contents), as a `files` block.
    - `familiarity()` (`open`): which touched files I changed before. Off, because matching a GitHub login to git authors is a guess (the noreply address, a name, or emails the user lists).

## Consequences

- A person can steer their own list and add panel content without a PR to the repo, and two people on one repo can have different inboxes over the same policy.
- The panel has a new section whose content nod does not write. The validator and the fixed blocks keep it inside the design; anything richer is a new block type, decided here.
- The runner (#57) owns the subprocess, the JSON-lines protocol, reload on save, the cache and the wire; the UI (#58) owns the renderers. This ADR fixes the contract between them and the kit.
- Not decided here: diff composition on the row's diff bar (after a screenshot, #58), repo-side analyzers (later), an LLM analyzer (later).

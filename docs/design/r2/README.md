# Round 2: A as the base, calmer, with a board view and grouping options

One app, `app/index.html` (self-contained; source in `_src/`, built with `_src/build.sh`, which inlines the round-1 data plus `_src/data2.js`).
States by URL hash: `#list`, `#list-peek`, `#list-compact`, `#board`, `#board-state`, `#board-epic`, `#group-a`, `#group-b`, `#epics`, `#group-c`,
`#batch`, `#batch-open`, `#unlock`, `#signed`, `#signed-list`, `#detail`, `#detail-open`, `#link`. `?theme=light` before the hash gives the light scheme.
Round 1 is untouched in the parent folder.

## What changed against round 1, and why

The feedback was: A's style is right, but far too much on screen. So the work was mostly removing things.

| Round 1 (A) | Round 2 | Why |
|---|---|---|
| Three panes: sidebar, list, permanent preview | One centred column, 920 px | The preview repeated what the row said and tripled the text on screen |
| Sidebar with lanes, counts by kind, "waiting on", keyboard legend | Gone. Lanes are the page sections; shortcuts sit behind `?` | Counts by kind answered a question nobody asks with 6 rows |
| Row: number, title, agent name, up to 3 tags, ask, diff stats, checks, age | Row: title, who and age, **one** tag, a 3-bar risk signal, the ask | These four are what you decide on |
| Checks on every row | Only when not green ("checks running", "1 check failing") | Green is the normal case |
| Background lane: 9 rows | Three sentences (2 wait on teammates, 3 with agents or CI, 4 merged) | "Nothing to do" should cost no reading |
| Preview pane always open | The focused row opens in place (`02`) | Brief on demand, and it is in the way before you sign |
| Batch modal: stat tiles, 5-column table, SHAs, JSON payload | Sentence, rows grouped by role, outcome per row; SHAs behind one disclosure | The user liked this dialog; it keeps its job and loses the table |
| Unlock as a second modal | Passphrase appears inside the same dialog | One surface from review to signed |
| Detail: 6 cards in two columns | Brief first, one card "Needed from you", a 7-step journey, then four folded sections | Reasons and ledger are for doubt, not for every visit |

### Density decisions

- **One tag per row**, picked by priority: changed since you signed → migration → core → module tier → dependency/docs/tooling.
- **Risk is a 3-bar meter**, not words. It is the brief's own risk plus what the classifiers raised. Red only at level 3.
- **Who, not which agent.** "Jonas · 2h". The agent name is in the opened row and the detail.
- **PR numbers are hidden in the calm list.** They show in the compact list, the batch details and everywhere a number is typed or linked.
- **FYI rows show the reason to care** ("test commands change") in place of a tag.
- **Two densities** (`01` calm, `03` compact). Calm is two lines per row, background folded. Compact is one line per row with number and age, background listed; 18 PRs fit on one screen.

## The views

- **List** (`01`–`03`): lanes *Needs you / Worth knowing / Background*.
- **Board** (`04`–`06`): same data, same cards language, a "Group by" switch.
  - *Waiting on* (default): You, Jonas, Ines, Agents & CI, Merged. Answers "who is the bottleneck".
  - *State*: Checks running → Needs a signature → Signed · merging → Merged. Answers "where is everything".
  - *Epic*: swimlanes per epic, columns by waiting-on. The two-dimensional view the board makes possible.
  - Cards carry signature pips (filled = signed, ring = yours), so "what is still missing" needs no click.
- **Batch dialog** (`11`–`14`), **list after signing** (`15`), **detail** (`16`, `17`), **deep link** (`18`).

## Epic / topic grouping: three options

### A · From the pull request itself (`07`)
A line `Epic: #431` in the PR brief (the brief template already exists for agents). Fallbacks: module, branch prefix.
- **Pro:** no extra API calls, the PR body is already fetched. Works on day one.
- **Con:** only as good as the agent's discipline. A missing line means no group. The module fallback gives groups of one (shown as "No epic").
- **Con:** knows nothing beyond PRs: no progress, no "what is left".
- **Needs:** one line in the brief template; a regex.
- **When:** v1-ready, but on its own it adds little. With 6 rows, three headers are more noise than help.

### B · GitHub issues (`08` list headers, `09` epic overview, `06` board swimlanes)
PRs close issues (`Closes #n`); issues are sub-issues of an epic issue. The epic shows issues done / merging / waiting on a human / not started, and who blocks it.
- **Pro:** answers a different and better question: "what holds up Billing v2", including work that has no PR yet.
- **Pro:** ties attention to goals, not to PRs. "Blocked by you (2)" is a strong nudge.
- **Con:** depends on the team using issues and sub-issues consistently. Many agent PRs have no issue (in the fake data, 12 of 18 are outside any epic).
- **Con:** more data and a new page; the tool grows from "attention" towards "project tracking".
- **Needs:** GraphQL: `closingIssuesReferences` per PR (can ride on the PR query), then `parent` and `subIssues` / `subIssuesSummary` per epic. About one extra query per poll plus one per open epic. Still fine with polling and no cache at this scale.
- **When:** after v1. The list header (`08`) is cheap once the data is there; the overview page (`09`) is the real feature.

### C · No grouping: filter plus order (`10`)
Epic is a filter chip above the list. Rows say what they unblock or need first ("unblocks #482", "needs #492 first (Jonas)"), and the lane is ordered so the unblocking PR comes first.
- **Pro:** keeps the list flat and calm; no headers for groups of one.
- **Pro:** "what should I sign first" is the question in the moment, and dependency answers it better than a topic name.
- **Con:** no overview of an epic. Dependencies must be declared.
- **Needs:** `Depends on #n` in the brief, or the base branch for stacked PRs (already in the PR data). The filter uses the same `Epic:` line as option A.
- **When:** v1.

### Recommendation on grouping
**v1: option C, fed by the two brief lines `Epic: #n` and `Depends on #n`.** No headers in the list. The board gets *Waiting on* and *State*.
**Later: option B** as an "Epics" view and as the *Epic* group-by on the board, once issues are used consistently. Skip option A's headers: they cost space and say less than C.

## Recommendation overall

- Ship the **calm list** as default with the density switch in settings (compact for people who want everything on one screen).
- Ship the **board** with *Waiting on* as default grouping. It is cheap because it is the same data and the same card.
- Keep the **batch dialog** as the centre of the tool: one sentence, grouped rows, outcome per row, one disclosure, unlock in place.
- Keep the **detail** folded by default; open "Signatures" automatically when something is unusual (a signature dropped, a signature held across a rebase).

## Open questions

1. **Default density?** Recommended: calm. Compact as a setting, remembered per user.
2. **Does a focused row open on its own, or on a key?** Recommended: on `space` or click. Auto-open on `j/k` makes the list jump.
3. **Hide PR numbers in the calm list?** Recommended: yes; show on hover and in compact. Say so if numbers are how the team talks about PRs.
4. **Is the risk meter trusted?** It mixes the agent's own statement with classifier facts. Recommended: classifiers set the floor, the agent may only raise it (matches decision 3).
5. **Board: can you sign from it?** Recommended: yes, "Sign…" on your column opens the same batch dialog with the column preselected.
6. **Peer and owner signatures without opening the row?** Recommended: allow, but the dialog marks rows you never opened ("not opened") so it is a conscious choice.
7. **Epics in v1?** Recommended: no page, no headers. Only the filter and the dependency hints (option C).
8. **Where is "Depends on" from?** Recommended: base branch for stacks, plus an optional line in the brief.

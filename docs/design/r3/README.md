# Round 3: attention-proportional space, detail panel, chronological view, onboarding

One app, `app/index.html` (self-contained). Source: `_src/app.html` + `_src/data2.js`, built with `_src/build.sh` (inlines the round-1 data).
States by URL hash: `#list`, `#list-panel`, `#list-panel-wide`, `#chrono`, `#chrono-open`, `#chrono-runs`, `#chrono-kind`, `#chrono-panel`,
`#board`, `#board-drawer`, `#batch`, `#unlock`, `#signed`, `#ob-1` … `#ob-4`, `#ob-3-join`, `#first-run`, `#clear`, `#link`, `#epics`.
The panel handle is draggable in the browser. Rounds 1 and 2 are untouched.

## What changed against round 2, and why

| Round 2 | Round 3 | Why |
|---|---|---|
| Every row in a lane had the same size | Four sizes, chosen by an attention rule | Space on screen should follow the attention a change deserves |
| Background was three sentences | Two one-liners that matter (yours and stuck) plus one folded cluster | The stuck ones were hidden inside a sentence |
| Detail: row expands in place, or a full page | **List:** resizable side panel with a drag handle. **Board:** overlay drawer | Focusing a row updates the panel; the list stays in view. The in-place expansion is gone |
| No diff stats on rows | `+312 −88` plus a quiet 38 px bar (length = size on a log scale, split = added/removed) | Requested back; the bar makes "small vs large" readable without reading numbers |
| One order (by lane) | Toggle **By attention / Chronological** | "What happened since I looked" is a different question from "what do I owe" |
| Board cards all alike | Card size follows the same tiers; low-risk cards fold into a dashed cluster | Same concept in both views |
| No onboarding | Four short steps, a first-run dashboard, a "nothing needs you" state | It is a local app; setup is mostly checks |

Unchanged from round 2: the batch dialog (review, unlock in place, signed), the deep-link landing, board group-by *State* and *Epic*, the Epics page.

## Attention tiers

Inputs, all already known per PR:

- `needsMe`: the policy result has an open signature slot that I can fill (peer, owner, self, re-attest).
- `risk`: 0–3. Classifiers set the floor; the agent's own statement may only raise it.
- `mine`: I am the prompter.
- `fyiForMe`: an FYI (by policy or declared) that I have not acked.
- `stuck`: a check is failing, or it has waited on someone for 12 hours or more.
- `merged`.

Rules, first match wins:

| # | Condition | Tier | Form |
|---|---|---|---|
| 1 | `needsMe` and (`risk` = 3 or not `mine`) | **1 Prominent** | title, one line of the brief, meta, diff, risk, the ask |
| 2 | `needsMe` (my own work, risk ≤ 2) | **2 Normal** | title, meta, diff, risk, the ask |
| 3 | `fyiForMe` | **3 One line** | title, the reason to care, diff, "Got it" |
| 4 | not `merged` and ((`mine` and `stuck`) or `risk` = 3) | **3 One line** | title, who and age, diff, status |
| 5 | everything else | **4 Folded** | part of "N low-risk changes"; expands in place to dim one-liners |

As code (this is what the mockup runs):

```ts
function tier(p): 1 | 2 | 3 | 4 {
  if (p.needsMe) return p.risk >= 3 || !p.mine ? 1 : 2;
  if (p.fyiForMe) return 3;
  if (!p.merged && ((p.mine && p.stuck) || p.risk >= 3)) return 3;
  return 4;
}
```

Why these rules:
- A teammate's work that needs me ranks above my own: I prompted mine and know what it is; I have not seen theirs.
- My own work only gets room when it needs me or is stuck. Otherwise my agents are fine without me.
- High risk never folds while it is open, even if it waits on someone else (`#479`).
- With the fake data: 3 prominent, 3 normal, 5 one-liners, 7 folded. The top half of the screen is the three PRs that deserve reading.

Sorting inside *Needs you*: tier, then risk, then age.

## Chronological view and how low-risk items are grouped

Sorted by last activity (push, signature, merge, check result). Rows show the event ("2 new commits", "your signature dropped") where the attention view shows the age. Three ways to fold tier-4 items were tried:

| Mechanism | Screenshot | Result with this data | Verdict |
|---|---|---|---|
| **Time bucket**: one cluster per bucket (last hour, earlier today, yesterday), placed at the end of the bucket | `04`, `05` | 3 buckets, 2 clusters, 1 single. Stable, always at most one cluster per bucket | **Pick** |
| **Consecutive run**: fold neighbours in time | `06` | Runs are broken by every important item: 5 singles and only 1 cluster of 2. Almost nothing folds | No. Strict time order, but it does not reduce anything |
| **Kind**: deps, tier 1, docs, signed by you, in a section below the timeline | `07` | 4 clusters, 2 of them with one item; and they leave the timeline | Good as the *label* of a cluster, not as the grouping |

Pick: **time buckets, with the kinds as the cluster's subtitle** ("4 low-risk changes · 1 tier 1 · 2 deps · 1 signed by you"). A bucket with one low-risk item shows it as a dim one-liner in place. Bucket sizes can grow with age (hour, rest of day, day, week).
In the attention view the same cluster sits at the end of *Background*. On the board it is a dashed card at the end of a column.

## Detail panel

- **List:** `Details` button or Enter opens a side panel; a 12 px handle with a visible grip resizes it (380–900 px, default 500). Focusing another row replaces the content. Esc or ✕ closes it; the list then recentres.
- **Board:** an overlay drawer (540 px), because the board needs its full width.
- Content: what is needed from you with the sign buttons, the brief, the journey, then folded sections (reasons, signatures, FYI, files).
- Narrow panel: the journey is a vertical list and "Look at" is dropped. From 620 px: horizontal journey, sections open (`03`).
- Trade-off visible in `03`: at 700 px the list has 700 px left and titles truncate. A sensible maximum is about half the window.

## Onboarding

Four steps, each mostly a list of checks.

1. **GitHub and repository** (`12`). Uses the existing `gh` login, shows the account and scopes, proposes the repo of the current folder. No new permission.
2. **Repository setup** (`13`). Checks for the policy file, the verifier workflow, the allowed-signers file and the required check. If missing: one setup PR adds them; the branch-protection change (required check on, required approvals 1 → 0) needs a repo admin and happens after the merge. If the repo is already set up, this step is a single green line and is skipped.
3. **Your signing key** (`14`, `15`). Create a key with a passphrase (or pick an existing one that has a passphrase). **The public key is enrolled in the repository, not on the GitHub account** (see below).
4. **Test signature** (`16`). Unlock, sign a test message, verify locally against the own public key: "verified ✓" immediately. Enrolment shows as pending until the PR merges.

Then the dashboard: `17` first run (legend of the four sizes and three lanes, the pending-key note, empty lanes with one sentence each), `18` nothing needs you.

### Key enrolment through the repo (pending the user's confirmation)

Changed from the original brief on the coordinator's instruction, **not yet confirmed by the user**:

- The trust root is a file in the repo, `.countersign/allowed_signers`, not the keys on a GitHub account.
- Reason: registering a signing key on GitHub needs `admin:ssh_signing_key` on the shared `gh` token. Any agent using that token could then register its own key on the account and forge attestations.
- Enrolling = the app opens a one-line PR that adds the public key. It touches `.countersign/**`, so the policy treats it as highest risk and a teammate has to sign it (`15`).
- The first person in a repo is the exception: their key is part of the setup PR (`14`).
- Until the PR merges the key is **pending**: everything can be read, signatures do not count yet.
- No extra `gh` scope is needed.

Consequences to settle if this is confirmed: the verifier reads `allowed_signers` from the base branch (like the policy); round-1/2 texts that say "verified against github.com/<user>.keys" must change; removing a key is also a PR.

## Recommendation

- Adopt the tier rule as written and keep it this small. Show the rule to users (first-run legend, and "why this size" in the panel later).
- Default view: *By attention*. *Chronological* with time buckets as the second tab.
- Panel closed by default; remember open/closed and width per user.
- Onboarding as four steps with repo-file enrolment, if the user confirms it.

## Open questions

1. **Does a teammate's PR that needs me always rank above my own?** Recommended: yes (rule 1). The alternative, risk only, puts my own medium-risk PR above a teammate's low-risk one.
2. **Should high-risk work that waits on someone else stay visible (rule 4)?** Recommended: yes, as one line, never folded while open.
3. **Chronological: sort by last activity or by creation?** Recommended: last activity, with the event shown on the row.
4. **Fold mechanism?** Recommended: time buckets, kinds as subtitle.
5. **May folded items be selected for signing?** They never need me by definition. Recommended: no checkboxes on tiers 3 and 4.
6. **Panel default?** Recommended: closed; Enter opens, the state is remembered.
7. **Diff bar scale?** Recommended: log scale to 1,000 lines. Lockfiles and generated files should be excluded from the count, or dependency bumps look huge.
8. **Key enrolment through `.countersign/allowed_signers`?** Recommended: yes. It removes the scope problem and makes the list of signers reviewable. Needs the user's confirmation.
9. **Who signs the very first setup PR?** Nobody can, the verifier does not exist yet. Recommended: it merges under the old rule (one GitHub approval), stated on the PR.
10. **What does a pending key allow?** Recommended: read everything, sign nothing; the sign buttons say "pending #501".

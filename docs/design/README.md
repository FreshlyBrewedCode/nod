# PR attention UI: three design directions

Static mockups with fake data (repo `tallyho/fieldbook`, viewer Mara, teammates Jonas and Ines, 18 agent-written PRs).
Working name of the tool in the mockups: **Countersign**. All three use the same data and the same four key moments, so they can be compared directly.

Open `a-triage/index.html`, `b-briefing/index.html`, `c-flow/index.html` in a browser. Each file is self-contained; states are switched by URL hash:
`#dashboard`, `#detail`, `#batch`, `#unlock`, `#signed`, `#link`. Add `?theme=light` or `?theme=dark` before the hash for the other colour scheme.
Sources are in `_src/` (`data.js` is shared and inlined by `_src/build.sh`; `_src/shots.sh` takes the screenshots).

Screenshots (1440 px wide) are in `screenshots/`, named `<direction>-<moment>.png`:
`1-dashboard`, `2-detail`, `3a-batch-review`, `3b-unlock`, `3c-signed`, `4-deeplink`.

## Shared across all three (design within the decisions)

- **Lock state is global**: a chip in the top bar, "Signing locked" or "Signing unlocked 14:48 · Lock now".
- **Signing is always two steps**: a review of exactly what gets signed (PR, role, head SHA, patch-id, what happens after), then the passphrase. The unlock offers "this batch only / 15 min / 1 hour".
- **The review says what happens next per PR**: "requirement met, agent merges" or "still waits on Jonas". A mixed batch shows "2 as peer, 3 as self".
- **Classifier reasons are always visible as fact → effect** ("modules/billing is tier 3 → needs another human"), with raised ones marked.
- **Attestation status names the mechanism**: "signed 5e0a91c, head moved (rebase), patch-id unchanged → still valid", or "content changed → no longer counts" (comes back as *Re-attest*).
- **Deep link**: opens a focused view with a banner "Opened from a link … nothing is signed". PRs whose head moved after the link was posted are flagged and **not preselected**.
- Only data GitHub gives us is used: title, body brief, diff stats, files, checks, comments, reactions, plus the policy output. "Prompted by" and the agent name come from the PR brief.

## A · Triage (`a-triage/`)

**Core idea.** An inbox with three lanes: *Needs you*, *Worth knowing*, *Background*. Dense rows, a preview pane, everything by keyboard (`j/k`, `x` select, `s` sign, `a` ack). Each row states the one thing asked of you ("Sign as peer", "Self-attest", "Re-attest", "Ack").

**Strengths**
- Fastest for the daily job: 6 PRs are scanned and signed in well under a minute.
- All 18 PRs on one screen without scrolling; the background lane proves that the rest is taken care of.
- Batch selection is native to a list (select lane, select by kind).
- Familiar pattern (mail, Linear), nearly no learning.

**Weaknesses**
- Invites signing without reading: the brief is in the side pane, not in the way.
- Says little about the team: who is blocked by whom is only a count in the sidebar.
- No story. Related PRs (an epic) are not shown together.
- Closest of the three to "a nicer PR list".

## B · Briefing (`b-briefing/`)

**Core idea.** A page you read from top to bottom: "since you last looked", a headline with counts, then PRs grouped by topic, each as a short brief (what, why, risk with classifier reasons, how verified, where to look). While reading you put PRs on a **signing tray** in the right rail; FYIs are acked inline with "Got it". Signing is a **signing sheet**, a document you sign.

**Strengths**
- Best for staying on top of things, which is the actual problem: you understand each change before you sign.
- Topic grouping gives context ("two of three Billing v2 PRs wait for you", "you signed #483 this morning").
- FYI has a natural home; reading is the ack.
- The signing sheet makes the weight of the act clear and doubles as a receipt.

**Weaknesses**
- Long (the dashboard is about 4 screens for 18 PRs). Slow if you come back five times a day.
- Topic grouping needs a source (epic reference in the brief, label, path); otherwise it falls back to module.
- The quality depends on the agent's PR brief. A poor brief makes a poor briefing.
- Weak on live state: where a PR is in the pipeline is one line of text.

## C · Flow (`c-flow/`)

**Core idea.** A board of where every PR is and who it waits on: *Checks & agents → Waiting on you → Waiting on teammates → Attested · merging → Merged*. A strip on top shows the bottlenecks ("6 wait on you, oldest 5h, 4 agent sessions idle"). Cards show the required signatures as pips (filled = signed, ring = you). Detail is a drawer with the PR's journey as a timeline. Batch is "Sign my lane…", and the review shows which card moves where.

**Strengths**
- Makes the cost of a missing human visible, for yourself and for teammates (your #479 has waited on Ines for a day).
- Signature pips answer "what is still missing" without opening anything.
- The timeline explains the rebase/patch-id story better than any table.
- Signing has a visible effect: the cards move.

**Weaknesses**
- FYI does not fit a flow; it is only a tag on cards, easy to miss.
- A board for 5–10 PRs a day is a lot of chrome; most columns are nearly empty most of the time.
- Cards are too small for a real brief, so the detail drawer is needed for every non-trivial PR.
- Risk of becoming a status dashboard people look at instead of acting on.

## What can be combined

| Piece | From | Fits into |
|---|---|---|
| Three lanes + keyboard + selection bar | A | base layout |
| Brief as what / why / risk / verified / look at | B | A's preview pane and detail (already there in short form) |
| "Since you last looked" header with counts and the *happened without you* list | B | top of A's list |
| Topic grouping inside *Needs you* | B | A, as optional grouping |
| Signature pips on rows/cards | C | A's rows (replaces the text "Sign as peer" plus shows what else is missing) |
| Journey timeline | C | detail view in A or B |
| Bottleneck strip ("waits on Jonas 2, Ines 1 · oldest 1d") | C | A's sidebar "Waiting on" |
| "After you sign: 4 mergeable, 1 still waits on Jonas" | all | keep everywhere |
| Signing sheet as receipt (`Signed by me` page) | B | any |
| "Changed since the link was posted → not preselected" | all | keep everywhere |

## Recommendation

**Build A as the frame and fill it with B's content; take two widgets from C.**

- The tool is opened many times a day for a few PRs. That is an inbox job, so the lanes, the keyboard and the selection bar from A are the base.
- The real risk of this tool is rubber-stamping. So the *Needs you* lane should not be one-line rows: use B's brief (what, why, risk with reasons, verified) as the row body for anything that is not self-attest on tier 1–2, and keep one-line rows for the rest. B's "since you last looked" line and "happened without you" list replace A's plain background lane.
- From C take the signature pips (on every row) and the journey timeline (in the detail view). Keep the board itself out of v1; a "Waiting on" block in the sidebar covers the bottleneck question for a team of three.
- The deep-link view of A/B (a focused list, changed PRs not preselected, tray on the right) is the same in all three and can be built once.

## Open questions for the user

1. **Default view: inbox (A) or briefing (B)?** Recommended: inbox with brief-style rows for risky PRs; the long briefing only as "since you last looked" header.
2. **May a batch include PRs you have not opened?** Recommended: yes for self-attest, but peer/owner signatures require that the brief was expanded once (a soft gate in the UI, not in the verifier).
3. **Unlock duration default.** Recommended: 15 minutes, with "this batch only" one click away; every signature still needs a click.
4. **Does a signature count as FYI ack?** Recommended: yes (shown that way in all mockups).
5. **Deep link with a moved head: preselect or not?** Recommended: not preselected, with "see what changed".
6. **Where does topic grouping come from?** Recommended: an `Epic: #431` line in the PR brief template, falling back to the module.
7. **Revoke.** The mockups show "Revoke a signature…". Recommended: support it as a signed `verdict: revoke` comment; needs a small addition to the verifier.
8. **Is "prompted by" trusted?** It comes from the brief, which the agent writes. Recommended: display only; the verifier decides self vs peer from the signer and the PR author on GitHub.

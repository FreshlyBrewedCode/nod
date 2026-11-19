---
title: Dashboard
description: Attention tiers, the list by attention and by time, the board, the detail panel and the keyboard.
section: Using nod
order: 1
---

The dashboard is the web app, paired with the `nod serve` on your machine. It shows one
repository, from your point of view: the same pull request looks different to you and to a
teammate.

## Attention tiers

A list where every pull request has the same height tells you nothing about where to look. In
nod, the space a pull request gets follows the attention it deserves. There are four
**attention tiers**; the first rule that matches wins.

| Tier | When | Shown as |
| --- | --- | --- |
| **1 Prominent** | It needs your nod, and it is high risk or a teammate's work | Title, one line of the brief, who and age, diff, risk, the ask |
| **2 Normal** | It needs your nod, it is your own work, risk low or medium | Title, who and age, diff, risk, the ask |
| **3 One line** | An [FYI](/docs/nodding#fyi) you have not acked; or it is open and either yours and stuck, or high risk | Title, the reason to care, diff, "Got it" or the status |
| **4 Folded** | Everything else | Part of a cluster, "7 low-risk changes", that expands in place |

Why these rules:

- A teammate's pull request that needs you ranks above your own. You prompted yours and know
  what it is; you have not seen theirs.
- Your own work only gets room when it needs you or is stuck. Otherwise your agents are fine
  without you.
- An open high-risk pull request is never folded, even while it waits on someone else.
- **Stuck** means a check is failing, or it has waited on a person for 12 hours or more.

Only tiers 1 and 2 have a checkbox: those are the pull requests you can nod.

Each row carries two small marks. The **diff indicator** is `+312 −88` and a short bar: its
length is the size on a log scale up to 1,000 lines, split into added and removed. Lockfiles and
generated files do not count. The **risk bars** are three bars, amber for low and medium, red for
high.

## List by attention

The default view. Three lanes, top to bottom:

- **Needs you**: pull requests that wait for your nod, sorted by tier, then risk, then age.
- **Worth knowing**: FYIs you have not acked. No input wanted.
- **Background**: everything else. The ones that are yours and stuck, or high risk, show as one
  line; the rest fold into one cluster at the end.

![The list by attention](./screenshots/list.webp)

## Chronological

The second tab of the list answers a different question: what happened since I looked? It is
sorted by last activity (a push, a nod, a merge, a check result), and each row says what
happened instead of how old it is. Rows are grouped into time buckets: last hour, earlier today,
yesterday, this week, older. Folded pull requests form one cluster at the end of each bucket.

![The chronological list, in time buckets](./screenshots/chronological.webp)

## Board

Columns instead of lanes. Group by:

- **Waiting on** (the default): You, one column per teammate who has to nod, Agents & CI, Merged.
- **State**: Checks running, Needs a signature, Signed · merging, Merged.

Card size follows the same tiers, and low-risk cards fold into a dashed cluster at the end of a
column. Grouping by epic is not built yet.

![The board, grouped by who a pull request waits on](./screenshots/board.webp)

## Detail panel

<kbd>Enter</kbd> or the **Details** button opens the focused pull request in a side panel. In the
list it sits next to the rows and can be resized (380 to 900 px); on the board it is a drawer over
the columns. Moving the focus replaces its content.

It shows, in this order:

1. **Needed from you**: the ask, what happens after your nod, and the buttons to sign or to add
   it to the batch.
2. **The brief**: what, why, risk, how it was verified, where to look. See
   [Agents](/docs/agents#the-brief).
3. **The journey**: opened, classified, nods, rebases, what it waits on now, what comes next.
4. Folded sections: why it needs you (the classifier findings), signatures, FYI acks, files.

![The detail panel next to the list](./screenshots/detail-panel.webp)

## Keyboard

| Key | Does |
| --- | --- |
| <kbd>j</kbd> <kbd>k</kbd> or <kbd>↓</kbd> <kbd>↑</kbd> | Next, previous row or card |
| <kbd>h</kbd> <kbd>l</kbd> or <kbd>←</kbd> <kbd>→</kbd> | Board: previous, next column |
| <kbd>Enter</kbd> | Open the details; open or close a cluster |
| <kbd>Esc</kbd> | Close the details, then clear the selection |
| <kbd>x</kbd> | Select for signing |
| <kbd>s</kbd> | Sign the selection, or the focused row |
| <kbd>e</kbd> | Got it, on an FYI |
| <kbd>g</kbd> <kbd>l</kbd> | List by attention |
| <kbd>g</kbd> <kbd>c</kbd> | List, chronological |
| <kbd>g</kbd> <kbd>b</kbd> | Board |
| <kbd>?</kbd> | Show the shortcuts |

## First run and empty states

A new setup shows a legend of the four sizes and the three lanes above the lanes, until you
dismiss it. Pull requests the verifier has not run on yet are counted below the lanes as "not
classified". When nothing waits for you, the top lane says so.

![The first-run dashboard with the legend](./screenshots/first-run.webp)

---
title: Settings
description: "The settings page, and its Repositories section: what nod reads, each one’s step, adding and removing."
section: Using nod
order: 5
---

> **Not released.** The settings page is on `main`. It changes the same repo list as
> [`nod repo`](/docs/cli#nod-repo); with `--dir` the list is [fixed](#a-fixed-list).
> `nod serve --fake --scenario repos` shows a list you can change without GitHub.

**Settings** in the avatar menu opens the settings page, `#/settings`. Its sections are listed on
the left (on a phone, as a row of tabs once there is more than one); each one has its own address,
`#/settings/<section>`, so a link opens it directly. This version has one section, Repositories.

## Repositories

`#/settings/repositories`: the [repo list](/docs/glossary), the repositories whose pull
requests share your dashboard. Reading a repository changes nothing in it.

Each row shows:

- the repository, as the dashboard names it: `owner/name` on github.com, `host/owner/name` on
  another host ([GitHub Enterprise](/docs/enterprise));
- its host, its step of the [ladder](/docs/quick-start#the-ladder) (Inbox, Shared policy,
  Enforced), and your key there: "your key signs here", "your key is pending · #501", "your key is
  not enrolled", or "no signing key";
- its next step, the same [offer](/docs/dashboard#offers) the card above the list makes, with its
  button. Here every repository shows its own, and **Not now** on the card does not hide it.
  Enforcing shows the command, `nod init --ruleset`, to run in a clone;
- **The ladder ›**, which opens the repository's [setup page](/docs/quick-start#the-ladder),
  where the steps are done;
- **Remove**, which asks once more. The repository's pull requests leave the dashboard; nothing
  changes in the repository, and you can add it again. Removing the last one leaves an empty list,
  and the dashboard shows "Add a repository" until there is one again.

![Settings, Repositories: three repositories at three steps, and adding one](./screenshots/settings-repositories.webp)

## Adding a repository

Under the list, **Add a repository** takes a repository in any of these forms:

- `owner/name`, for github.com;
- `host/owner/name`, for another host: `acme.ghe.com/finance/ledger`;
- a link: to the repository, to a pull request or anything else in it, or its clone URL.

**Suggested** lists repositories where you have open pull requests or a review is requested from
you, the busiest first, without those already in the list. **Add** next to one adds it.

`nod serve` checks that your `gh` login on that host can read the repository. One it cannot find
or read is not added, and the page says why. A repository you add starts at the inbox step for
you: nothing of nod needs to be in it.

With no repository at all, the dashboard is a page with the same field and suggestions:
**Add a repository**.

## A fixed list

`nod serve --dir <clone>` (or `nod serve` in a clone while the repo list is empty) reads that one
clone. The section then shows it read-only, with a note that says why and what to run instead:
[`nod repo add`](/docs/cli#nod-repo), then `nod serve` without `--dir`.

---
title: Glossary
description: The terms these docs use, and what each one means.
section: Reference
order: 4
---

| Term | Meaning |
| --- | --- |
| **app** | The dashboard `nod serve` serves itself at `http://127.0.0.1:<port>/`: always the server's own version, and installable from the browser. The link `nod serve` prints opens it. Not released. [The app](/docs/app) |
| **approval** | A GitHub review that approves a pull request's head commit, by someone with write access other than its author. It fills a slot like a nod does, unless the policy asks for a nod only. Without a key you give one from the batch dialog (**Approve**). Not released. [Policy](/docs/policy#approvals), [Nodding](/docs/nodding#approve-or-nod) |
| **ask** | What the dashboard asks of you on a pull request: Self-attest, Sign as peer, Sign as owner or Re-attest; without a key that signs in the repository, Approve. [Nodding](/docs/nodding#the-ask) |
| **attention tier** | One of four sizes a pull request is shown in: prominent, normal, one line, folded. [Dashboard](/docs/dashboard#attention-tiers) |
| **badge** | How many pull requests need you most (the prominent rows, in every repository): on the installed app's icon, and in the tab's title as `(3) nod`. Not released. [The app](/docs/app#the-badge) |
| **batch** | One or more pull requests nodded with one signature, or approved on GitHub together. A batch across repositories is one signature per repository, made with one unlock. Not released: across repositories. [Nodding](/docs/nodding#the-batch-dialog) |
| **batch dialog** | The dialog every way to sign or approve opens: review, unlock, signed; or review, approved |
| **board** | The dashboard's view in columns, by who a pull request waits on or by state. [Dashboard](/docs/dashboard#board) |
| **brief** | The pull request description an agent writes: what, why, risk, verified, look at. [Agents](/docs/agents#the-brief) |
| **category** | Where the policy puts a pull request: `auto`, `decide` or `fyi`. [Policy](/docs/policy#requirements) |
| **channel** | Where updates come from: **stable**, the releases (npm's `latest`), or **next**, every change merged to `main` (npm's `next`). Chosen in Settings → Server; a new choice is checked at once and installs nothing by itself. Not released. [Updates](/docs/updates#the-channel) |
| **check** | The check run named `nod` on a pull request's head commit. Once enforced, a ruleset requires it; before that, a pull request that still needs someone gets a neutral check that blocks nothing. [Verifier](/docs/verifier#the-check) |
| **clone cache** | Where nod keeps its own clone of each repository of the repo list: `$XDG_CACHE_HOME/nod/clones/<host>/<owner>/<repo>.git`, blobless and bare, made on first use. `nod serve` computes patch-ids there. Deleting it costs a new clone, nothing else. Not released. [CLI](/docs/cli#files-and-environment) |
| **classifier** | A function in the policy that looks at a pull request and reports findings. [Policy](/docs/policy#built-in-classifiers) |
| **cluster** | Folded pull requests shown as one row, "7 low-risk changes", that expands in place |
| **dashboard** | The web app, paired with `nod serve`: the app it serves on your machine, the hosted web app, or on another device the named host's. [Dashboard](/docs/dashboard) |
| **deep link** | A link that opens a pull request or a batch in the dashboard. It never approves by itself. [Nodding](/docs/nodding#deep-links) |
| **detail panel** | The side panel (list) or drawer (board) showing one pull request |
| **device link** | The second link `nod serve --allow-host` prints, also as a QR code. It pairs another device through the named host. [On your phone](/docs/phone) |
| **enforced** | The last step of the ladder: the default branch requires the `nod` check (`nod init --ruleset`), so a pull request merges only once its requirement is met. Not released. [Verifier](/docs/verifier#enforced-or-not) |
| **enrolment** | Getting a public key into `.nod/allowed_signers`, through a pull request. Per repository: each one trusts its own list. [Signing keys](/docs/keys#enrolment) |
| **finding** | One fact a classifier reports: a tag, a sentence, optionally a risk |
| **FYI** | A pull request people should notice without anyone having to nod. [Nodding](/docs/nodding#fyi) |
| **FYI ack** | "Got it" on an FYI: an unsigned 👀 reaction |
| **home-screen app** | The dashboard added to a phone's home screen: it opens without the browser's bars. On an iPhone it keeps its own pairing. [On your phone](/docs/phone#on-the-home-screen) |
| **host link** | The link `nod serve` prints. It pairs the web app with the server; for a release it opens the app. [The app](/docs/app#open-it) |
| **hosted web app** | The dashboard published at `ui.nod.frebreco.de`, where deep links point: the stable release's at the root, `main`'s at `/next`. Not paired, it hands a link over to the app or to your named host (link forwarding). [Status](/docs/status#released) |
| **installed app** | The app installed from the browser: a window and an icon of its own, it opens even when `nod serve` is not running and says so. Not released. [The app](/docs/app#install-it) |
| **inbox** | The first step of the ladder: the dashboard for you alone, with nothing in the repository. Your `nod serve` classifies the pull requests itself (local classification), and Needs you holds your review requests and your own stuck pull requests. Not released. [Dashboard](/docs/dashboard#the-inbox) |
| **kit** | `@frebreco/nod/kit`: the helpers the policy and the verifier import. [Architecture](/docs/architecture#the-kit) |
| **ladder** | The four steps of adopting nod, each one opt-in: inbox, shared policy, signing, enforced. [Quick start](/docs/quick-start#the-ladder) |
| **local classification** | At the inbox step, your `nod serve` classifying a pull request itself, with the built-in classifiers, on the file list and brief GitHub returns. For your dashboard only: nothing is posted, nothing is required. A verifier summary always wins. The panel says "classified by your nod, not the repo". Not released. [Dashboard](/docs/dashboard#the-inbox) |
| **lane** | A section of the list by attention: Needs you, Worth knowing, Background |
| **link forwarding** | The hosted web app handing a deep link over, one tap per link: to the app on your machine (the default port, or the one you confirmed), or to your named host after you confirmed it once in the same browser. Not released: on `ui.nod.frebreco.de/next` only, while links in comments open the root. [The app](/docs/app#links-from-github), [On your phone](/docs/phone#links-from-github) |
| **named host** | The https name a TLS proxy such as `tailscale serve` gives `nod serve`, named with `--allow-host`, so another device reaches it. It has its own token and its own unlock. [On your phone](/docs/phone) |
| **named nod** | A nod by a person the policy names |
| **nod** | A signed statement by a human approving a pull request, posted as a comment. Also the name of the tool and of the check |
| **nod only** | A slot that only a nod fills, never an approval: `peer({ approvals: false })`, and any change to nod's own setup. Not released. [Policy](/docs/policy#approvals) |
| **`nod serve`** | The local server on your machine. [CLI](/docs/cli#nod-serve) |
| **Not now** | What puts an offer away. This browser remembers it, per repository and step; the avatar menu still lists the step. Not released. [Dashboard](/docs/dashboard#offers) |
| **offer** | A calm card above the list with the next step of the ladder for a repository and you: share one policy, sign your own agent pull requests, let agents merge on their own. One at a time, never in the way; the avatar menu lists every step offered. Not released. [Dashboard](/docs/dashboard#offers) |
| **patch-id** | A hash of a pull request's diff against its base. It survives a clean rebase. [Nodding](/docs/nodding#when-a-nod-counts) |
| **payload** | The one line of JSON a nod signs |
| **peer nod** | A nod by a signer other than the pull request's author |
| **policy** | `.nod/policy.ts`: classifiers and rules that decide what a pull request needs. [Policy](/docs/policy) |
| **prompter** | The human who prompted the agent. On GitHub, the pull request's author |
| **review request** | GitHub asking a person or a team to review a pull request. At the inbox step, one asked of you, or of a team you are in, puts the pull request in Needs you. A mention is not one. Not released. [Dashboard](/docs/dashboard#the-inbox) |
| **repo list** | The repositories `nod serve` reads into one dashboard, in order, kept in `$XDG_CONFIG_HOME/nod/config.json`. Changed in Settings → Repositories (add, with suggestions, and remove) or with `nod repo add`, `remove` and `list`; a repository from any GitHub host can be in it. With `--dir` it is that one clone and cannot be changed. Not released. [Settings](/docs/settings#repositories), [CLI](/docs/cli#nod-repo) |
| **repo chip** | A repository's short name on each row, card and panel, once the dashboard shows more than one repository. With one, there is none and the top bar names it. Not released. [Dashboard](/docs/dashboard#many-repositories) |
| **remote token** | The pairing token of the named host, kept apart from the host link's. [On your phone](/docs/phone#a-lost-phone) |
| **requirement** | What a pull request needs before it may merge: nothing, or slots for the author (self), someone else (peer) and named people, each filled by a nod or an approval. [Policy](/docs/policy#requirements) |
| **risk** | 0 to 3: none, low, medium, high. The highest risk of any finding |
| **rule** | A function in the policy that turns findings into a requirement or an FYI |
| **self nod** | A nod by the pull request's author: the prompter attesting their own agent's work |
| **service** | `nod serve` run in the background by your system: a systemd user unit on Linux, a LaunchAgent on macOS. `nod service install` sets it up, or **Run nod in the background** in Settings → Server. Not released. [In the background](/docs/background) |
| **settings page** | `#/settings`, from **Settings** in the avatar menu: sections on the left, one at a time on the right: Repositories, Signing, App, Server and Other device. Not released. [Settings](/docs/settings) |
| **setup page** | `#/setup`: one repository's ladder, its four steps, where each stands for the repository and you, and where they are done. Reached from an offer, the avatar menu's next steps, or the repository's row in Settings → Repositories (**The ladder ›**). Not released: before, it was onboarding, shown first. [Quick start](/docs/quick-start#the-ladder) |
| **setup PR** | The pull request `nod init` opens to add `.nod/` and the workflow. [Quick start](/docs/quick-start) |
| **shared policy** | The second step of the ladder: the setup PR is merged, and the verifier classifies every pull request the same way for everyone. Its check never blocks until enforced. [Quick start](/docs/quick-start#the-ladder) |
| **signer** | A person whose public key is in `.nod/allowed_signers` |
| **signing** | The third step of the ladder, one person at a time: your key enrolled in `.nod/allowed_signers`, so you can nod, your own agents' pull requests included. [Signing keys](/docs/keys) |
| **signing key** | Your ed25519 key, encrypted on your machine. [Signing keys](/docs/keys#the-key-file) |
| **slot** | One part of a requirement that a person fills: the self or peer level, or a named person's. [Policy](/docs/policy#requirements) |
| **stale** | A nod whose pull request changed after it was made. It no longer counts |
| **sticky comment** | The verifier's one comment on a pull request, updated in place. Posted only once the check is enforced. [Verifier](/docs/verifier#the-sticky-comment) |
| **stuck** | A check is failing, the pull request conflicts with its base, a reviewer requested changes, or it has waited on a person for 12 hours or more. Not released: the conflict and the requested changes. [Dashboard](/docs/dashboard#attention-tiers) |
| **suggestion** | A repository nod offers to add to the repo list (Settings, `nod repo add`): one where you have open pull requests or review requests, on each GitHub host you are logged in to, that the list does not have. Not released. [Settings](/docs/settings#adding-a-repository) |
| **summary** | The machine-readable result in the check run's output, read by `nod serve`. [Verifier](/docs/verifier#the-summary) |
| **tailnet** | Your private Tailscale network: the devices logged in to it. [On your phone](/docs/phone) |
| **trust root** | `.nod/allowed_signers` on the default branch |
| **update** | A release of your channel other than the one `nod serve` runs: newer, or older after a switch to stable. A pill in the top bar says so; Settings → Server shows its release notes and installs it when you click **Update**, never by itself. Not released. [Updates](/docs/updates) |
| **unlock** | Decrypting the signing key into the memory of `nod serve`, for 15 minutes or one signature. With a named host, your machine and the other device each unlock on their own |
| **verifier** | `.nod/verify.ts`, run by the workflow on every pull request event. It sets the check. [Verifier](/docs/verifier) |

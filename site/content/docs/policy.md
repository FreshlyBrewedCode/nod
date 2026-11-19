---
title: Policy
description: The files nod puts in your repository, the built-in classifiers, your own classifiers, and requirements.
section: Your repository
order: 1
---

The **policy** decides what a pull request needs before it may merge. It is a TypeScript file in
your repository, `.nod/policy.ts`. You read it, change it, and delete what you don't need.

## The files in your repository

The setup PR adds these, and from then on they are yours:

| File | What it is |
| --- | --- |
| `.nod/policy.ts` | The policy: classifiers and rules |
| `.nod/classifiers/` | Your own classifiers. Ships with one example, `module-tier.ts` |
| `.nod/verify.ts` | [The verifier](/docs/verifier), readable top to bottom |
| `.nod/allowed_signers` | Who can nod: the [trust root](/docs/keys) |
| `.nod/package.json`, `.nod/bun.lock` | Pin the kit, the package of helpers these files import |
| `.github/workflows/nod.yml` | Runs the verifier |

The verifier always runs the policy **from the default branch**, never from the pull request. A
change to the policy is a pull request like any other, and since it is under `.nod/`, it always
needs a peer nod.

## How a policy works

Two steps.

1. **Classifiers** look at the pull request and report **findings**. A finding has a tag, a
   sentence for humans, and optionally a risk from 0 (none) to 3 (high): "3 files under
   docs/\*\*", "+1240 −12 in 18 files", "module billing is tier 1".
2. **Rules** turn findings into a **requirement**.

The policy the setup PR adds, without its comments:

```ts
// .nod/policy.ts
import {
  declared,
  definePolicy,
  dependencies,
  diffSize,
  fyi,
  matchAny,
  paths,
  peer,
  rule,
  self,
} from "@frebreco/nod/kit";

import { moduleTiers } from "./classifiers/module-tier.ts";

const DOCS = ["docs/**", "**/*.md", "**/*.mdx", "LICENSE"];

export default definePolicy({
  classifiers: [
    paths({
      ".nod/**": { tag: "nod-setup", risk: 3 },
      ".github/**": { tag: "ci-config", risk: 3 },
      "docs/**": { tag: "docs", risk: 0 },
      "*.md": { tag: "docs", risk: 0 },
    }),
    diffSize(),
    dependencies(),
    moduleTiers(),
    declared(),
  ],

  rules: [
    rule("high risk needs a peer", (f) => f.risk >= 3 && peer),
    rule("medium or low risk needs a self nod", (f) => f.risk >= 1 && self),
    rule(
      "code needs a self nod",
      (f) => !f.files.every((file) => matchAny(DOCS, file.path)) && !f.has("pure-module") && self,
    ),
    rule("declared FYI", (f) => f.has("fyi") && fyi),
  ],
});
```

## Requirements

| Requirement | Who has to nod |
| --- | --- |
| `none` | Nobody. The pull request merges on its own once CI is green |
| `self` | Any signer; the human behind the agent attesting their own agent's work is enough |
| `peer` | A signer other than the pull request's author |
| `named("login")` | That person, in addition to whatever else is asked |

Everything combines to the strictest. The risk of a pull request is the highest risk of any
finding, and the requirement is the strictest any rule returned. **No rule can lower what another
rule asked for**: a rule that returns nothing adds nothing. To let something through, narrow the
rule that asks for more.

A rule may also return `fyi`, which asks nobody to nod and marks the pull request as worth
knowing. The **category** follows: `decide` when someone has to nod, `fyi` when a rule marked it,
`auto` otherwise.

Two things are built in and cannot be lowered by rules:

- A change under `.nod/**` or `.github/workflows/**` always needs a peer nod. These are the
  trust root, the policy, the verifier, and workflows that could create a check of their own.
- A classifier or a rule that throws counts as high risk and needs a peer nod. A broken policy
  fails safe.

## Built-in classifiers

| Classifier | What it reports |
| --- | --- |
| `paths({ glob: { tag, risk } })` | One finding per pattern that matches a changed file. Patterns match the whole path from the root; `**` spans folders |
| `diffSize()` | Exactly one finding by changed lines: `size:s`, `size:m` from 50 lines (low), `size:l` from 400 (medium), `size:xl` from 1,000 (high). Lockfiles and generated files do not count. Tune with `diffSize({ thresholds: { 1: 100, 2: 600, 3: 1500 } })` |
| `dependencies()` | `deps-only` (low) when only manifests and lockfiles change, `deps` (medium) when code changes along with them |
| `declared()` | What the [brief](/docs/agents#the-brief) declares: `declared:risk`, `fyi`, `epic`, `depends-on`. Declarations can only raise risk |

The file list comes from `git`, not from GitHub's files API, which stops at 3,000 files.

## A classifier of your own

A classifier is a plain function from the pull request to a list of findings. The example that
ships, `.nod/classifiers/module-tier.ts`, reads how critical a module is from
`modules/<name>/module.json` (`{ "tier": 1 }` is critical, 3 is a leaf). Shortened:

```ts
// .nod/classifiers/module-tier.ts
import { matchAny, type Classifier, type Finding, type Risk } from "@frebreco/nod/kit";

export function moduleTiers(options: ModuleTierOptions = {}): Classifier {
  const root = (options.root ?? "modules").replace(/\/+$/, "");
  const riskOfTier = options.riskOfTier ?? { 1: 3, 2: 2, 3: 0 };

  // A named function, so a crash shows up as "moduleTiers: …" in the check.
  return async function moduleTiers({ files, readBaseFile }) {
    const findings: Finding[] = [];
    const modules = new Set<string>();
    // … collect the names of the modules the changed files belong to …

    for (const name of [...modules].sort()) {
      const tier = await baseTier(readBaseFile, `${root}/${name}/module.json`);
      const risk = tier === null ? undefined : riskOfTier[tier];
      if (risk === undefined) {
        findings.push({
          classifier: "moduleTiers",
          tag: "unknown-tier",
          risk: 2,
          detail: `module ${name} has no tier on the base branch yet`,
        });
      } else {
        findings.push({
          classifier: "moduleTiers",
          tag: `tier-${tier}`,
          risk,
          detail: `module ${name} is tier ${tier}`,
        });
      }
    }
    // … `core` for files under core/**, `pure-module` when only tier-3 modules change …
    return findings;
  };
}
```

What a classifier gets:

- `pr`: repo, number, title, body, author, labels, base branch, head commit. Title, body and
  labels are written by the author: treat them as untrusted.
- `files`: every changed file with its added and removed lines.
- `readBaseFile(path)`: a file as it is on the **base branch**. The pull request cannot change
  what this returns, so it cannot lower its own module's tier on the way in.

Then use the tags in a rule:

```ts
rule("billing needs alice", (f) => f.has("tier-1") && named("alice")),
rule("migrations need alice and a peer", (f) => f.has("migration") && [named("alice"), peer]),
```

A rule sees `f.risk`, `f.files`, `f.findings`, `f.has(...tags)`, `f.tagged(tag)` and
`f.touches(...globs)`.

## Trying a change

Change `.nod/policy.ts` in a pull request. That pull request is still judged by the policy on the
default branch, and needs a peer nod. The new policy applies to every pull request from the
moment it merges: the verifier re-runs on the next event of each.

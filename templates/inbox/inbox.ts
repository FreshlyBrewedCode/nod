/**
 * Your own inbox: nod's personal layer. It decides how much of your
 * attention a pull request gets and what you want to know about it. Only
 * your `nod serve` runs it; it never changes a repository's risk or what a
 * pull request needs, and nothing it says reaches GitHub.
 *
 * Save the file and nod serve loads it again. Try it on one pull request:
 *
 *   nod inbox test owner/name#123
 *
 * Without this file the built-in defaults run; with it, exactly what it
 * lists. Docs: https://nod.frebreco.de/docs/inbox
 */
import { defaults, defineInbox } from "@frebreco/nod/kit/inbox";

export default defineInbox({
  ...defaults(),
});

// A fuller one, to start from (the analyzer is in ./analyzers/):
//
// import { defaults, defineInbox, mute, watch } from "@frebreco/nod/kit/inbox";
// import { todoCount } from "./analyzers/todo-count.ts";
//
// const base = defaults();
//
// export default defineInbox({
//   classifiers: [
//     ...base.classifiers,
//     // Up a tier, and a quiet tag on the row, when a PR touches these paths.
//     watch("src/auth/**", { tag: "auth" }),
//     // Into Background: dependency bumps, and PRs that only touch docs.
//     mute({ authors: ["renovate", "dependabot"], paths: ["docs/**"] }),
//   ],
//   analyzers: [...base.analyzers, todoCount],
//   // More for some repositories only (owner/name, or a glob):
//   repos: {
//     "acme/billing": { classifiers: [watch("migrations/**", { tag: "db", fyi: true })] },
//   },
// });

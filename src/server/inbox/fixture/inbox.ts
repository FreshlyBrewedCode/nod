/**
 * The inbox `nod serve --fake --scenario insights` runs (#57): the kit's
 * defaults, and analyzers and classifiers of mine that reach every block
 * type and every state over the fake's PRs (canned diffs and history,
 * `fake-subjects.ts`). Fictional, as all fake data.
 *
 * - +1 with a tag: `watch` on core/auth (#476, "you: watching auth") and on
 *   modules/billing (#483 rises from folded to one line);
 * - mute: CI changes (#478 leaves Worth knowing for Background);
 * - blocks: `stats`, `series` (bars and a line), `breakdown` (the default's
 *   bar, a donut here), `files` (the defaults' hotspots and overlaps), `text`;
 * - states: `running` (#482 for 8 s after each load; its `open` analyzer
 *   15 s), `failed` (#485 throws), and a timeout (#490 spins: the process
 *   is killed and restarted, the state says so).
 */
import { classifier, defaults, defineInbox, watch } from "@frebreco/nod/kit/inbox";

import {
  areas,
  coverage,
  linesByFile,
  notes,
  size,
  slow,
  spin,
  trend,
  waits,
} from "./analyzers/fake.ts";

const base = defaults();

export default defineInbox({
  classifiers: [
    ...base.classifiers,
    watch("core/auth/**", { tag: "auth" }),
    watch("modules/billing/**", { tag: "billing" }),
    classifier("quiet-ci", ({ pr }) =>
      pr.title.startsWith("ci:") ? [{ attention: "mute", detail: "you mute CI changes" }] : [],
    ),
  ],
  analyzers: [
    ...base.analyzers,
    size,
    linesByFile,
    areas,
    trend,
    notes,
    slow,
    waits,
    coverage,
    spin,
  ],
});

import { RISK_NAMES, type Classifier, type Finding, type Risk } from "./types.ts";

const RISK_WORDS: Record<string, Risk> = {
  none: 0,
  low: 1,
  medium: 2,
  high: 3,
  "0": 0,
  "1": 1,
  "2": 2,
  "3": 3,
};

/**
 * Reads what the author or agent declared in the PR brief, one statement per
 * line (bullets and bold are fine):
 *
 * - `Risk: none | low | medium | high` (or `0`–`3`) → tag `declared:risk`
 *   with that risk;
 * - `FYI` or `FYI: …` (or a title starting with `FYI`) → tag `fyi`;
 * - `Epic: #12` → tag `epic`, detail `#12`;
 * - `Depends on #7` (several numbers allowed) → tag `depends-on`, one per number.
 *
 * The body is written by the author, so declared intent may only **raise**
 * risk or attention: the policy takes the highest risk of all findings, so
 * `Risk: low` cannot lower what the paths or the diff size said.
 */
export function declared(): Classifier {
  return ({ pr }) => {
    const findings: Finding[] = [];
    let risk: Risk | undefined;
    let fyi = /^\s*\[?FYI\b/i.test(pr.title);
    const epics = new Set<string>();
    const deps = new Set<string>();
    for (const raw of pr.body.split(/\r?\n/)) {
      const line = raw
        .replace(/^[\s>*+-]+/, "")
        .replace(/\*\*|__/g, "")
        .trim();
      const r = /^risk\s*:\s*(none|low|medium|high|[0-3])\b/i.exec(line);
      if (r) {
        const value = RISK_WORDS[r[1]!.toLowerCase()]!;
        risk = risk === undefined ? value : (Math.max(risk, value) as Risk);
        continue;
      }
      if (/^fyi\b\s*(?::|$|[-–—])/i.test(line)) fyi = true;
      const e = /^epic\s*:\s*#(\d+)\b/i.exec(line);
      if (e) epics.add(`#${e[1]}`);
      const d = /^depends\s+on\s*:?\s*((?:#\d+[\s,]*(?:and\s+)?)+)/i.exec(line);
      if (d) for (const n of d[1]!.matchAll(/#(\d+)/g)) deps.add(`#${n[1]}`);
    }
    if (risk !== undefined) {
      findings.push({
        classifier: "declared",
        tag: "declared:risk",
        risk,
        detail: `the brief declares risk ${RISK_NAMES[risk]}`,
      });
    }
    if (fyi)
      findings.push({ classifier: "declared", tag: "fyi", detail: "the brief marks this as FYI" });
    for (const n of epics) findings.push({ classifier: "declared", tag: "epic", detail: n });
    for (const n of deps) findings.push({ classifier: "declared", tag: "depends-on", detail: n });
    return findings;
  };
}

import { describe, expect, test } from "bun:test";

import {
  declared,
  diffSize,
  paths,
  type Classifier,
  type Finding,
  type Risk,
} from "./classifiers/index.ts";
import { defaultRules, definePolicy, evaluatePolicy, fyi, rule } from "./policy.ts";
import { named, none, peer, self } from "./requirement.ts";
import { context, file } from "./test-support.ts";

/**
 * The example custom classifier, in the style of "module tiers": every
 * `modules/<name>/module.json` holds `{ "tier": 1 | 2 | 3 }`, tier 1 being
 * the most critical. The tier is read from the base branch, so a PR cannot
 * lower its own module's tier.
 */
const moduleTiers: Classifier = async ({ files, readBaseFile }) => {
  const findings: Finding[] = [];
  const modules = new Set<string>();
  let other = 0;
  for (const f of files) {
    const m = /^modules\/([^/]+)\//.exec(f.path);
    if (m) modules.add(m[1]!);
    else if (f.path.startsWith("core/")) {
      findings.push({
        classifier: "moduleTiers",
        tag: "core",
        risk: 3,
        detail: `touches core: ${f.path}`,
      });
    } else other++;
  }
  const riskOfTier: Record<number, Risk> = { 1: 2, 2: 1, 3: 0 };
  let allTier3 = modules.size > 0;
  for (const name of modules) {
    const json = await readBaseFile(`modules/${name}/module.json`);
    const tier = json ? (JSON.parse(json) as { tier?: number }).tier : undefined;
    if (tier !== 3) allTier3 = false;
    if (tier === undefined || !(tier in riskOfTier)) {
      findings.push({
        classifier: "moduleTiers",
        tag: "new-module",
        risk: 2,
        detail: `${name} has no tier on the base branch`,
      });
    } else {
      findings.push({
        classifier: "moduleTiers",
        tag: `tier-${tier}`,
        risk: riskOfTier[tier]!,
        detail: `module ${name} is tier ${tier}`,
      });
    }
  }
  if (allTier3 && findings.every((f) => f.tag !== "core") && other === 0) {
    findings.push({
      classifier: "moduleTiers",
      tag: "pure-module",
      detail: "only tier-3 modules change",
    });
  }
  return findings;
};

const policy = definePolicy({
  classifiers: [moduleTiers, diffSize(), declared()],
  rules: [...defaultRules(), rule("core needs alice", (f) => f.has("core") && named("alice"))],
});

const base = {
  "modules/billing/module.json": '{ "tier": 1 }',
  "modules/search/module.json": '{ "tier": 2 }',
  "modules/icons/module.json": '{ "tier": 3 }',
};

describe("the module-tier example", () => {
  test("a PR touching only tier-3 modules is low risk and merges on its own", async () => {
    const r = await evaluatePolicy(
      policy,
      context([file("modules/icons/a.svg"), file("modules/icons/b.ts", 10)], {}, base),
    );
    expect(r).toMatchObject({
      category: "auto",
      risk: 0,
      requirement: none,
      fyi: false,
      errors: [],
    });
    expect(r.reasons.map((f) => f.tag)).toContain("pure-module");
  });

  test("touching core is high risk: a peer and alice", async () => {
    const r = await evaluatePolicy(
      policy,
      context([file("modules/icons/a.ts"), file("core/engine.ts")], { author: "bob" }, base),
    );
    expect(r).toMatchObject({
      category: "decide",
      risk: 3,
      requirement: { level: "peer", named: ["alice"] },
    });
    expect(r.rules.map((a) => a.rule)).toEqual([
      "high risk needs a peer",
      "low or medium risk needs a self nod",
      "core needs alice",
    ]);
    expect(r.reasons[0]!.risk).toBe(3);
  });

  test("a tier-1 module needs a self nod", async () => {
    const r = await evaluatePolicy(
      policy,
      context([file("modules/billing/rounding.ts", 5)], {}, base),
    );
    expect(r).toMatchObject({ category: "decide", risk: 2, requirement: self });
  });

  test("a PR cannot lower its module's tier: the tier comes from the base", async () => {
    const files = [file("modules/billing/module.json"), file("modules/billing/rounding.ts")];
    const r = await evaluatePolicy(policy, context(files, {}, base));
    expect(r.risk).toBe(2);
    expect(r.reasons.map((f) => f.tag)).toContain("tier-1");
  });

  test("a new module has no tier yet", async () => {
    const r = await evaluatePolicy(policy, context([file("modules/fresh/index.ts")], {}, base));
    expect(r.reasons.map((f) => f.tag)).toContain("new-module");
    expect(r.requirement).toEqual(self());
  });
});

describe("declared intent only raises", () => {
  test("Risk: low cannot lower core", async () => {
    const r = await evaluatePolicy(
      policy,
      context([file("core/engine.ts")], { body: "Risk: low\nFYI" }, base),
    );
    expect(r).toMatchObject({
      risk: 3,
      category: "decide",
      requirement: { level: "peer" },
      fyi: true,
    });
  });

  test("Risk: none cannot lower a medium-risk change", async () => {
    const r = await evaluatePolicy(
      policy,
      context([file("modules/billing/a.ts")], { body: "Risk: none" }, base),
    );
    expect(r.risk).toBe(2);
  });

  test("Risk: high raises a tier-3 change to a peer", async () => {
    const r = await evaluatePolicy(
      policy,
      context([file("modules/icons/a.svg")], { body: "Risk: high" }, base),
    );
    expect(r).toMatchObject({ risk: 3, requirement: peer, category: "decide" });
  });

  test("FYI turns an auto PR into an FYI", async () => {
    const r = await evaluatePolicy(
      policy,
      context([file("modules/icons/a.svg")], { title: "FYI: new icon set" }, base),
    );
    expect(r).toMatchObject({ category: "fyi", requirement: none, fyi: true });
  });

  test("a rule cannot lower another rule's requirement", async () => {
    const lenient = definePolicy({
      classifiers: [paths({ "core/**": { tag: "core", risk: 3 } })],
      rules: [(f) => f.has("core") && peer, () => none, (f) => f.risk < 99 && [none, fyi]],
    });
    const r = await evaluatePolicy(lenient, context([file("core/a.ts")]));
    expect(r).toMatchObject({ requirement: peer, category: "decide", fyi: true });
  });
});

describe("built-in safety", () => {
  const empty = definePolicy({ classifiers: [], rules: [] });

  test("an empty policy lets everything merge", async () => {
    expect(await evaluatePolicy(empty, context([file("src/a.ts")]))).toMatchObject({
      category: "auto",
      requirement: none,
      risk: 0,
    });
  });

  test("changes to .nod/** and workflows always need a peer's nod, not an approval", async () => {
    for (const path of [".nod/allowed_signers", ".nod/policy.ts", ".github/workflows/nod.yml"]) {
      const r = await evaluatePolicy(empty, context([file(path)]));
      expect(r).toMatchObject({ category: "decide", risk: 3 });
      expect(r.requirement).toEqual({
        level: "peer",
        named: [],
        nodsOnly: { level: "peer", named: [] },
      });
      expect(r.reasons[0]).toMatchObject({ classifier: "nod", tag: "protected", risk: 3 });
    }
  });

  test("protectedPaths can be changed, visibly", async () => {
    const custom = definePolicy({
      classifiers: [],
      rules: [],
      protectedPaths: [".nod/allowed_signers"],
    });
    expect((await evaluatePolicy(custom, context([file(".nod/policy.ts")]))).requirement).toEqual(
      none,
    );
    expect(
      (await evaluatePolicy(custom, context([file(".nod/allowed_signers")]))).requirement,
    ).toEqual(peer({ approvals: false }));
  });

  test("a throwing classifier fails safe", async () => {
    const broken: Classifier = function brokenTiers() {
      throw new Error("module.json is not JSON");
    };
    const r = await evaluatePolicy(
      definePolicy({ classifiers: [broken], rules: [] }),
      context([file("a.ts")]),
    );
    expect(r).toMatchObject({
      risk: 3,
      requirement: peer({ approvals: false }),
      errors: ["brokenTiers: module.json is not JSON"],
    });
    expect(r.reasons[0]).toMatchObject({ classifier: "brokenTiers", tag: "error", risk: 3 });
  });

  test("a throwing rule or one returning a promise fails safe", async () => {
    const p = definePolicy({
      classifiers: [],
      rules: [
        rule("throws", () => {
          throw new Error("boom");
        }),
        rule("async", (() => Promise.resolve(none)) as unknown as () => false),
      ],
    });
    const r = await evaluatePolicy(p, context([file("a.ts")]));
    expect(r.requirement).toEqual(peer({ approvals: false }));
    expect(r.errors).toEqual([
      "throws: boom",
      "async: returned something that is not a requirement or fyi",
    ]);
  });
});

describe("approvals (ADR 0006)", () => {
  test("peer and self as plain values accept approvals; called with approvals: false, nods only", async () => {
    const p = definePolicy({
      classifiers: [],
      rules: [
        rule("plain", () => peer),
        rule("nod only", () => self({ approvals: false })),
        rule("bob", () => named("bob", { approvals: false })),
      ],
    });
    const r = await evaluatePolicy(p, context([file("a.ts")]));
    expect(r.requirement).toEqual({
      level: "peer",
      named: ["bob"],
      nodsOnly: { level: "self", named: ["bob"] },
    });
    // The rules list carries plain objects, never the `peer` function itself.
    expect(typeof r.rules[0]!.requirement).toBe("object");
    expect(JSON.parse(JSON.stringify(r.rules[0]))).toEqual({
      rule: "plain",
      requirement: { level: "peer", named: [] },
      fyi: false,
    });
  });

  test("enforced: true is kept, anything else is left out", () => {
    expect(definePolicy({ classifiers: [], rules: [], enforced: true }).enforced).toBe(true);
    expect("enforced" in definePolicy({ classifiers: [], rules: [] })).toBe(false);
  });
});

describe("defaultRules", () => {
  const p = definePolicy({ classifiers: [diffSize(), declared()], rules: defaultRules() });

  test("risk 0 → none, 1–2 → self, 3 → peer", async () => {
    expect((await evaluatePolicy(p, context([file("a.ts", 10)]))).requirement).toEqual(none);
    expect((await evaluatePolicy(p, context([file("a.ts", 60)]))).requirement).toEqual(self());
    expect((await evaluatePolicy(p, context([file("a.ts", 500)]))).requirement).toEqual(self());
    expect((await evaluatePolicy(p, context([file("a.ts", 5000)]))).requirement).toEqual(peer());
  });

  test(".github/** needs a peer", async () => {
    expect(
      (await evaluatePolicy(p, context([file(".github/dependabot.yml")]))).requirement,
    ).toEqual(peer());
  });

  test("custom FYI tags", async () => {
    const docs = definePolicy({
      classifiers: [paths({ "docs/**": { tag: "docs", risk: 0 } })],
      rules: defaultRules({ fyiTags: ["fyi", "docs"] }),
    });
    expect(await evaluatePolicy(docs, context([file("docs/a.md")]))).toMatchObject({
      category: "fyi",
      fyi: true,
    });
  });
});

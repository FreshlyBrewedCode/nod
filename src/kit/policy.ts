/**
 * The policy engine: classifiers produce findings, rules map findings to
 * requirements, and everything combines to the strictest. A repo's
 * `.nod/policy.ts` is one {@link definePolicy} call that reads top to bottom:
 *
 * ```ts
 * export default definePolicy({
 *   classifiers: [paths({ "core/**": { tag: "core", risk: 3 } }), diffSize(), dependencies(), declared()],
 *   rules: [...defaultRules(), (f) => f.has("core") && named("alice")],
 * });
 * ```
 *
 * Nothing can lower a result: the risk is the highest risk of any finding,
 * and the requirement is the strictest any rule returned. That is what makes
 * declared intent (and any LLM step later) "raise only".
 */
import { matchAny } from "./classifiers/glob.ts";
import { preview } from "./classifiers/paths.ts";
import type { Classifier, ClassifierContext, Finding, Risk } from "./classifiers/types.ts";
import type { ChangedFile } from "./patch-id.ts";
import { none, peer, self, strictest, type Requirement } from "./requirement.ts";

/** A rule's way of saying "people should notice this", without asking anyone for a nod. */
export interface FyiMark {
  readonly fyi: true;
}

/** Marks the PR as FYI: `(f) => f.has("docs") && fyi`. */
export const fyi: FyiMark = Object.freeze({ fyi: true });

/** What a rule may return: requirements, FYI, a list of them, or nothing (any falsy value). */
export type RuleResult =
  | Requirement
  | FyiMark
  | readonly (Requirement | FyiMark)[]
  | false
  | null
  | undefined
  | 0
  | "";

/** A rule: an ordinary function over the findings. */
export type Rule = ((facts: PolicyFacts) => RuleResult) & { ruleName?: string };

/** What a rule sees. */
export interface PolicyFacts {
  /** The classifier context: the PR and its changed files. */
  readonly ctx: ClassifierContext;
  readonly files: readonly ChangedFile[];
  readonly findings: readonly Finding[];
  /** The highest risk of any finding (0 when none has one). */
  readonly risk: Risk;
  /** Whether any finding has one of these tags. */
  has(...tags: string[]): boolean;
  /** The findings with this tag. */
  tagged(tag: string): Finding[];
  /** Whether any changed file matches one of these globs. */
  touches(...globs: string[]): boolean;
}

/** A policy, as returned by {@link definePolicy}. */
export interface Policy {
  readonly classifiers: readonly Classifier[];
  readonly rules: readonly Rule[];
  readonly protectedPaths: readonly string[];
}

/**
 * Paths that always need a peer nod, whatever the rules say: the trust root,
 * the policy and the verifier (`.nod/**`, ADR 0002), and workflows, which
 * could create a `nod` check of their own. Override with `protectedPaths`
 * in {@link definePolicy}, visibly in the repo's policy file.
 */
export const PROTECTED_PATHS: readonly string[] = [".nod/**", ".github/workflows/**"];

/**
 * Defines a policy. `classifiers` run in order and their findings are
 * collected; then every rule runs and the results combine to the strictest.
 *
 * Built in, and never lowered by rules:
 * - a changed file under `protectedPaths` (default {@link PROTECTED_PATHS})
 *   gives a risk-3 finding tagged `protected` and requires a peer;
 * - a classifier or rule that throws gives a risk-3 finding tagged `error`
 *   and requires a peer, so a broken policy fails safe.
 */
export function definePolicy(policy: {
  classifiers: readonly Classifier[];
  rules: readonly Rule[];
  protectedPaths?: readonly string[];
}): Policy {
  return {
    classifiers: policy.classifiers,
    rules: policy.rules,
    protectedPaths: policy.protectedPaths ?? PROTECTED_PATHS,
  };
}

/** Gives a rule a name, shown in the result's `rules` list. */
export function rule(name: string, fn: (facts: PolicyFacts) => RuleResult): Rule {
  return Object.assign((facts: PolicyFacts) => fn(facts), { ruleName: name });
}

/** Where a PR goes: merges on its own, needs a human, or is worth knowing about. */
export type Category = "auto" | "decide" | "fyi";

/** A rule that asked for something. */
export interface AppliedRule {
  rule: string;
  requirement: Requirement | null;
  fyi: boolean;
}

/** Result of {@link evaluatePolicy}. */
export interface PolicyResult {
  /** `decide` when any nod is required, else `fyi` when marked, else `auto`. */
  category: Category;
  risk: Risk;
  requirement: Requirement;
  /** Whether people should notice the PR (also true for some `decide` PRs). */
  fyi: boolean;
  /** Every finding, highest risk first. */
  reasons: Finding[];
  /** The rules that asked for a requirement or FYI. */
  rules: AppliedRule[];
  /** Classifiers or rules that threw. The policy failed safe for each. */
  errors: string[];
}

/** Runs a policy on a PR. */
export async function evaluatePolicy(
  policy: Policy,
  ctx: ClassifierContext,
): Promise<PolicyResult> {
  const findings: Finding[] = [];
  const errors: string[] = [];
  const requirements: Requirement[] = [none];
  const applied: AppliedRule[] = [];

  const guarded = ctx.files
    .filter((f) => matchAny(policy.protectedPaths, f.path))
    .map((f) => f.path);
  if (guarded.length) {
    findings.push({
      classifier: "nod",
      tag: "protected",
      risk: 3,
      detail: `changes nod's own setup: ${preview(guarded)}`,
    });
    requirements.push(peer);
    applied.push({ rule: "protected paths", requirement: peer, fyi: false });
  }

  for (const [i, classify] of policy.classifiers.entries()) {
    try {
      findings.push(...(await classify(ctx)));
    } catch (e) {
      const name = classify.name || `classifier ${i + 1}`;
      errors.push(`${name}: ${message(e)}`);
      findings.push({
        classifier: name,
        tag: "error",
        risk: 3,
        detail: `classifier failed: ${message(e)}`,
      });
      requirements.push(peer);
    }
  }

  const facts = makeFacts(ctx, findings);
  let isFyi = false;
  for (const [i, r] of policy.rules.entries()) {
    const name = r.ruleName || r.name || `rule ${i + 1}`;
    let result: RuleResult;
    try {
      result = r(facts);
    } catch (e) {
      errors.push(`${name}: ${message(e)}`);
      requirements.push(peer);
      applied.push({ rule: name, requirement: peer, fyi: false });
      continue;
    }
    if (!result) continue;
    const outcomes = Array.isArray(result) ? result : [result as Requirement | FyiMark];
    let req: Requirement | null = null;
    let marked = false;
    for (const o of outcomes) {
      if (isFyiMark(o)) marked = true;
      else if (isRequirement(o)) req = req ? strictest(req, o) : o;
      else if (o) {
        // e.g. an async rule returning a promise: fail safe rather than ignore it
        errors.push(`${name}: returned something that is not a requirement or fyi`);
        req = req ? strictest(req, peer) : peer;
      }
    }
    if (req) requirements.push(req);
    if (marked) isFyi = true;
    if ((req && (req.level !== "none" || req.named.length)) || marked) {
      applied.push({ rule: name, requirement: req, fyi: marked });
    }
  }

  const requirement = strictest(...requirements);
  const needsNod = requirement.level !== "none" || requirement.named.length > 0;
  return {
    category: needsNod ? "decide" : isFyi ? "fyi" : "auto",
    risk: facts.risk,
    requirement,
    fyi: isFyi,
    reasons: [...findings].sort((a, b) => (b.risk ?? -1) - (a.risk ?? -1)),
    rules: applied,
    errors,
  };
}

/** Options for {@link defaultRules}. */
export interface DefaultRulesOptions {
  /** Paths that need a peer (default `.nod/**` and `.github/**`). */
  peerPaths?: readonly string[];
  /** Tags that make a PR FYI (default `fyi`, as set by {@link declared}). */
  fyiTags?: readonly string[];
}

/**
 * A sensible starting point:
 * - risk 3, or a change under `.nod/**` or `.github/**` → a peer nod;
 * - risk 1 or 2 → a self nod;
 * - risk 0 → nothing (auto-merge);
 * - a finding tagged `fyi` → FYI.
 */
export function defaultRules(options: DefaultRulesOptions = {}): Rule[] {
  const peerPaths = options.peerPaths ?? [".nod/**", ".github/**"];
  const fyiTags = options.fyiTags ?? ["fyi"];
  return [
    rule("high risk needs a peer", (f) => f.risk >= 3 && peer),
    rule("nod and CI config need a peer", (f) => f.touches(...peerPaths) && peer),
    rule("low or medium risk needs a self nod", (f) => f.risk >= 1 && self),
    rule("FYI", (f) => f.has(...fyiTags) && fyi),
  ];
}

function makeFacts(ctx: ClassifierContext, findings: readonly Finding[]): PolicyFacts {
  const risk = findings.reduce<Risk>(
    (max, f) => (f.risk !== undefined && f.risk > max ? f.risk : max),
    0,
  );
  return {
    ctx,
    files: ctx.files,
    findings,
    risk,
    has: (...tags) => findings.some((f) => tags.includes(f.tag)),
    tagged: (tag) => findings.filter((f) => f.tag === tag),
    touches: (...globs) => ctx.files.some((f) => matchAny(globs, f.path)),
  };
}

function isFyiMark(o: unknown): o is FyiMark {
  return typeof o === "object" && o !== null && (o as FyiMark).fyi === true;
}

function isRequirement(o: unknown): o is Requirement {
  return (
    typeof o === "object" && o !== null && "level" in o && Array.isArray((o as Requirement).named)
  );
}

function message(e: unknown): string {
  return (e instanceof Error ? e.message : String(e)).slice(0, 300);
}

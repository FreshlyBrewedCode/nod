import { describe, expect, test } from "bun:test";

import { GITHUB_ACTIONS_APP_ID, isPlanRefusal, nodRuleset } from "./ruleset.ts";
import { setupPrBody } from "./pr-body.ts";
import {
  allowedSignersLine,
  defaultKitSpec,
  KIT_SPEC_PLACEHOLDER,
  loadTemplates,
  parseSigner,
  renderSetup,
} from "./setup-files.ts";

const KEY = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOv1bJ1q7m2fYwq9nSx0cPZ3oG7r2y6m5dJb0R8pQz1x";
const alice = { login: "alice", publicKey: `${KEY} alice@laptop` };
const SHA = "5a6fb495d7936dbe15069979607003fab4dc71e5";

describe("rendering the setup", () => {
  test("every template lands at its place, the kit pinned, the signers enrolled", async () => {
    const files = renderSetup(await loadTemplates(), {
      kitSpec: `github:FreshlyBrewedCode/nod#${SHA}`,
      signers: [alice, { login: "bob", publicKey: KEY }],
    });
    expect(files.map((f) => f.path)).toEqual([
      ".github/workflows/nod.yml",
      ".nod/allowed_signers",
      ".nod/classifiers/module-tier.ts",
      ".nod/.gitignore",
      ".nod/package.json",
      ".nod/policy.ts",
      ".nod/verify.ts",
    ]);
    const pkg = JSON.parse(files.find((f) => f.path === ".nod/package.json")!.content);
    expect(pkg.dependencies["@frebreco/nod"]).toBe(`github:FreshlyBrewedCode/nod#${SHA}`);
    expect(JSON.stringify(files)).not.toContain(KIT_SPEC_PLACEHOLDER);
    const signers = files.find((f) => f.path === ".nod/allowed_signers")!.content;
    expect(signers).toStartWith("# Who can nod");
    expect(signers).toEndWith(`\nalice namespaces="nod" ${KEY}\nbob namespaces="nod" ${KEY}\n`);
    expect(signers).not.toContain("alice@laptop");
  });

  test("the workflow follows the hygiene rules of finding 01", async () => {
    const yml = (await loadTemplates()).find(
      (t) => t.path === ".github/workflows/nod.yml",
    )!.content;
    expect(yml).toMatch(/^permissions: \{\}$/m);
    expect(yml).toContain("persist-credentials: false");
    expect(yml).toContain("ref: ${{ github.event.repository.default_branch }}");
    expect(yml).toContain("types: [opened, synchronize, reopened, edited]");
    expect(yml).toContain("types: [created, edited, deleted]");
    expect(yml).toContain("bun install --frozen-lockfile --ignore-scripts");
    expect(yml).not.toMatch(/^ {2}nod:/m); // the job is not named nod
    // third-party actions pinned by a full SHA
    for (const m of yml.matchAll(/uses: (\S+)/g)) expect(m[1]).toMatch(/@[0-9a-f]{40}$/);
    // ${{ }} only for numbers and fixed strings, never in a run: line
    const code = yml
      .split("\n")
      .map((l) => l.replace(/(^|\s)#.*$/, ""))
      .join("\n");
    const expressions = [...code.matchAll(/\$\{\{([^}]*)\}\}/g)].map((m) => m[1]!.trim());
    for (const e of expressions) {
      expect(e).toMatch(
        /^(github\.event\.(pull_request|issue)\.number( \|\| github\.event\.issue\.number)?|github\.event\.repository\.default_branch|github\.token|steps\.app-token\.outputs\.token)$/,
      );
    }
    expect(expressions.length).toBeGreaterThanOrEqual(3);
    for (const line of code.split("\n").filter((l) => /^\s*run:/.test(l)))
      expect(line).not.toContain("${{");
  });

  test("bad input is refused", async () => {
    const templates = await loadTemplates();
    expect(() => renderSetup(templates, { kitSpec: "has space", signers: [] })).toThrow();
    expect(() => renderSetup([], { kitSpec: "^1.0.0", signers: [] })).toThrow(/lack/);
  });
});

describe("signers", () => {
  test("--signer and --signer-key", () => {
    expect(parseSigner(`alice ${KEY} a comment`)).toEqual({
      login: "alice",
      publicKey: `${KEY} a comment`,
    });
    expect(parseSigner(`${KEY} bob@desk\n`, "bob")).toEqual({
      login: "bob",
      publicKey: `${KEY} bob@desk`,
    });
    expect(allowedSignersLine(alice)).toBe(`alice namespaces="nod" ${KEY}`);
  });

  test("only ed25519 keys and real logins", () => {
    expect(() => parseSigner("alice ssh-rsa AAAAB3NzaC1yc2E")).toThrow(/ed25519/);
    expect(() => parseSigner(`-alice ${KEY}`)).toThrow(/login/);
    expect(() => parseSigner(KEY)).toThrow();
    expect(() => parseSigner(`alice ${KEY}`, "alice")).toThrow(/ed25519/);
  });
});

test("the default kit spec: a release's version, else the checkout's commit", () => {
  expect(defaultKitSpec("1.2.3", SHA)).toBe("^1.2.3");
  expect(defaultKitSpec("1.3.0-next.4", SHA)).toBe("1.3.0-next.4");
  expect(defaultKitSpec("0.0.0-development", SHA)).toBe(`github:FreshlyBrewedCode/nod#${SHA}`);
  expect(() => defaultKitSpec("0.0.0-development", null)).toThrow(/--kit/);
});

test("the ruleset requires nod from GitHub Actions, zero approvals, no bypass", () => {
  const r = nodRuleset();
  expect(r.bypass_actors).toEqual([]);
  expect(r.conditions.ref_name.include).toEqual(["~DEFAULT_BRANCH"]);
  const pr = r.rules.find((x) => x.type === "pull_request")!;
  expect(pr.parameters).toMatchObject({ required_approving_review_count: 0 });
  const checks = r.rules.find((x) => x.type === "required_status_checks")!;
  expect(checks.parameters).toMatchObject({
    required_status_checks: [{ context: "nod", integration_id: GITHUB_ACTIONS_APP_ID }],
  });
  expect(
    isPlanRefusal(
      '{"message":"Upgrade to GitHub Pro or make this repository public to enable this feature."}',
    ),
  ).toBe(true);
  expect(isPlanRefusal("Not Found")).toBe(false);
});

describe("the setup PR body", () => {
  const body = setupPrBody({
    repo: "acme/widgets",
    defaultBranch: "main",
    signers: [alice],
    kitSpec: "^1.2.3",
    isPrivate: true,
  });

  test("says what each file is", () => {
    for (const f of [
      ".nod/policy.ts",
      ".nod/classifiers/module-tier.ts",
      ".nod/verify.ts",
      ".nod/allowed_signers",
      ".nod/bun.lock",
      ".github/workflows/nod.yml",
    ])
      expect(body).toContain(f);
    expect(body).toContain("Enrolled here: `alice`");
  });

  test("the old rule, the admin step, the limits, the one-human note", () => {
    expect(body).toContain("merges under the current rules");
    expect(body).toContain("nod init --ruleset --repo acme/widgets");
    expect(body).toContain("**0** required approvals");
    expect(body).toContain("GitHub Actions");
    expect(body).toContain("Allow auto-merge");
    expect(body).toContain("GitHub Pro, Team or Enterprise");
    expect(body).toContain("push a workflow file");
    expect(body).toContain("--admin");
    expect(body).toContain("`workflow` scope");
    expect(body).toContain("only human");
    expect(body).toContain("2026-12-02");
    expect(body).not.toMatch(/\n\n\n/);
  });

  test("public repos skip the plan note; no signer is said plainly", () => {
    const pub = setupPrBody({
      repo: "acme/widgets",
      defaultBranch: "main",
      signers: [],
      kitSpec: "^1.2.3",
      isPrivate: false,
    });
    expect(pub).not.toContain("GitHub Pro");
    expect(pub).toContain("nobody yet");
  });
});

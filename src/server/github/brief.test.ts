import { expect, test } from "bun:test";

import { parseBody, plain } from "./brief";

test("bold labels, as the sandbox's agents write them", () => {
  const body = [
    "**What** `runAll()` retries a failing job up to twice before giving up.",
    "",
    "**Why** Nightly imports fail about once a week on a transient network error.",
    "",
    "**Risk:** high: core, every job goes through this.",
    "",
    "**Verified** Unit-tested by hand with a job that fails once.",
    "",
    "**Look at** Retries are immediate, with no backoff.",
    "",
    "Epic: #12",
    "Depends on #33, #35",
    "",
    "_Opened by tern (agent) on behalf of alice._",
  ].join("\n");
  expect(parseBody(body)).toEqual({
    brief: {
      what: "`runAll()` retries a failing job up to twice before giving up.",
      why: "Nightly imports fail about once a week on a transient network error.",
      risk: "high: core, every job goes through this.",
      verified: "Unit-tested by hand with a job that fails once.",
      lookAt: ["Retries are immediate, with no backoff."],
    },
    epic: 12,
    dependsOn: [33, 35],
    agent: "tern",
  });
});

test("headings with paragraphs and a list under Look at", () => {
  const body = [
    "## What",
    "Adds day-based proration.",
    "",
    "Credit notes for downgrades.",
    "",
    "## Why",
    "Support fixes these by hand.",
    "## Risk",
    "Money math.",
    "## How it was verified",
    "- 41 unit tests",
    "- replayed 300 plan changes",
    "## Look at",
    "- `modules/billing/proration.ts`",
    "- `modules/billing/proration.test.ts` (the property test)",
    "",
    "## Notes",
    "Not part of the brief.",
    "",
    "🤖 Generated with [Claude Code](https://claude.com/claude-code)",
  ].join("\r\n");
  const parsed = parseBody(body);
  expect(parsed.brief).toEqual({
    what: "Adds day-based proration. Credit notes for downgrades.",
    why: "Support fixes these by hand.",
    risk: "Money math.",
    verified: "41 unit tests replayed 300 plan changes",
    lookAt: [
      "`modules/billing/proration.ts`",
      "`modules/billing/proration.test.ts` (the property test)",
    ],
  });
  expect(parsed.agent).toBe("Claude Code");
});

test("plain labels with a colon, and a bulleted list after an inline label", () => {
  const parsed = parseBody(
    "What: bump zod\nWhy: security fix\nRisk: low\nVerified: CI\nLook at:\n- package.json\n- bun.lock\n\nCo-Authored-By: Codex <codex@example.invalid>\n",
  );
  expect(parsed.brief).toEqual({
    what: "bump zod",
    why: "security fix",
    risk: "low",
    verified: "CI",
    lookAt: ["package.json", "bun.lock"],
  });
  expect(parsed.agent).toBe("Codex");
});

test("a body without a brief becomes a one-paragraph what; trailers are left out", () => {
  expect(
    parseBody(
      "Fixes the [login](https://x.test) button\non Safari.\n\nSecond paragraph.\n\nCloses #3",
    ).brief,
  ).toEqual({
    what: "Fixes the login button on Safari.",
    why: "",
    risk: "",
    verified: "",
    lookAt: [],
  });
  expect(parseBody("Depends on #4\n\nThe actual text.").brief?.what).toBe("The actual text.");
  expect(parseBody("").brief).toBeNull();
  expect(parseBody(null).brief).toBeNull();
});

test("code blocks are not read as labels; comments are dropped", () => {
  const parsed = parseBody(
    "<!-- template: What / Why -->\n**What** real\n```\nWhy: in code\n```\n",
  );
  expect(parsed.brief).toMatchObject({ what: "real", why: "" });
});

test("the agent: an Agent line, a bot author, or nothing", () => {
  expect(parseBody("Agent: Claude Code\n\nhi").agent).toBe("Claude Code");
  expect(parseBody("bump", "renovate[bot]").agent).toBe("Renovate");
  expect(parseBody("bump", "dependabot[bot]").agent).toBe("Dependabot");
  expect(parseBody("a plain body").agent).toBeNull();
});

test("depends-on and epic lines in bullets and bold", () => {
  const parsed = parseBody("- **Epic:** #431\n- Depends on #485 and #492\n");
  expect(parsed.epic).toBe(431);
  expect(parsed.dependsOn).toEqual([485, 492]);
});

test("plain keeps code and drops emphasis and links", () => {
  expect(plain("**bold** _it_ `x_y` [a](b) ![img](c)")).toBe("bold it `x_y` a");
});

/**
 * My inbox over `nod serve --fake` (ADR 0009, #57): the fake has no clone,
 * so each open PR gets canned files, a canned unified diff and a canned git
 * history, made up from what the PR's facts say (its title's area, its
 * diff size and file count). The real runner and the real analyzers run on
 * them, through the kit's `fakeInboxIO`, so `diffComposition`, `hotspots`
 * and `overlapsMyWork` show what they would on a real clone.
 */

import { fakeInboxIO } from "../../kit/inbox/context.ts";
import { hashKey } from "../../kit/inbox/run.ts";
import type { ChangedFile } from "../../kit/patch-id.ts";
import type { FileChange } from "../../shared/protocol";
import type { PrFacts } from "../view";
import type { InboxSubject } from "./service";

const slug = (title: string) =>
  title
    .replace(/^[^:]*:\s*/, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .split("-")
    .slice(0, 3)
    .join("-") || "change";

/** A number from 0 to `n - 1`, the same every time for the same text. */
const pick = (text: string, n: number) => Number.parseInt(hashKey(text).slice(0, 6), 16) % n;

/** The files a fake PR changes: its own list when the data set has one, else made up from its title. */
export function fakeFiles(f: Pick<PrFacts, "title" | "number" | "diff" | "files">): ChangedFile[] {
  if (f.files?.length) return f.files.map(changed);
  const area = /^([a-z-]+):/.exec(f.title)?.[1] ?? "app";
  const name = slug(f.title);
  const count = Math.max(1, f.diff.files - f.diff.excluded.files);
  const paths: string[] = [];
  if (area === "deps") paths.push("package.json");
  else if (area === "docs") paths.push(`docs/${name}.md`, "docs/index.md");
  else if (area === "ci")
    paths.push(".github/workflows/ci.yml", "vitest.workspace.ts", "package.json");
  else {
    const dir = area === "core" ? `core/${name.split("-")[0]}` : `modules/${area}`;
    paths.push(`${dir}/${name}.ts`, `${dir}/${name}.test.ts`);
    // Two of the data set's PRs, one of them mine, share a file: `overlapsMyWork` has work.
    if (/tenant/i.test(f.title)) paths.push("core/tenant/context.ts");
    paths.push(`docs/modules/${area}.md`);
    for (let i = 2; paths.length < count; i++) paths.push(`${dir}/${name}-${i}.ts`);
  }
  const list = paths.slice(0, Math.max(count, 1));
  // Code gets most of the lines, tests a third of that, docs the rest.
  const weight = (p: string) => (p.endsWith(".md") ? 1 : p.includes(".test.") ? 3 : 8);
  const total = list.reduce((s, p) => s + weight(p), 0);
  const out = list.map((path) => ({
    path,
    status: "modified" as const,
    added: Math.round((f.diff.added - f.diff.excluded.added) * (weight(path) / total)),
    removed: Math.round((f.diff.removed - f.diff.excluded.removed) * (weight(path) / total)),
    binary: false,
  }));
  if (f.diff.excluded.files)
    out.push({
      path: "bun.lock",
      status: "modified",
      added: f.diff.excluded.added,
      removed: f.diff.excluded.removed,
      binary: false,
    });
  return out;
}

const changed = (c: FileChange): ChangedFile => ({
  path: c.path,
  status: "modified",
  added: c.added,
  removed: c.removed,
  binary: false,
});

/** A unified diff with the files' line counts: every fourth line of code a comment. */
export function fakeDiff(files: readonly ChangedFile[]): string {
  const sections: string[] = [];
  for (const f of files) {
    if (!/\.(ts|tsx|js)$/.test(f.path)) continue;
    const lines: string[] = [" export {};"];
    const test = f.path.includes(".test.");
    for (let i = 0; i < f.added; i++)
      lines.push(
        i % 4 === 3
          ? `+// ${test ? "covers" : "keeps"} case ${i}`
          : test
            ? `+  expect(run(${i})).toBe(${i});`
            : `+export const v${i} = ${i};`,
      );
    for (let i = 0; i < f.removed; i++) lines.push(`-export const old${i} = ${i};`);
    sections.push(
      [
        `diff --git a/${f.path} b/${f.path}`,
        `--- a/${f.path}`,
        `+++ b/${f.path}`,
        `@@ -1,${f.removed + 1} +1,${f.added + 1} @@`,
        ...lines,
        "",
      ].join("\n"),
    );
  }
  return sections.join("");
}

/** `git log --name-only` over the base for hotspots: each file changed 0 to 4 times last month. */
function fakeLog(files: readonly ChangedFile[], now: number): string {
  const out: string[] = [];
  for (const f of files) {
    const times = pick(f.path, 5);
    for (let i = 0; i < times; i++) {
      const date = new Date(now - (i + 1) * 4 * 86_400_000).toISOString().slice(0, 10);
      const sha = hashKey(`${f.path}${i}`).repeat(5);
      out.push(`\0${sha}\tdev@example.test\tA teammate\t${date}\n${f.path}\n`);
    }
  }
  return out.join("");
}

/** A fake PR as my inbox reads it. */
export function fakeSubject(repo: string, f: PrFacts, now: number): InboxSubject | null {
  if (f.state !== "open" && f.state !== "draft") return null;
  const files = fakeFiles(f);
  const diff = fakeDiff(files);
  const brief = f.brief;
  return {
    pr: {
      repo,
      number: f.number,
      title: f.title,
      body: brief
        ? `## What\n${brief.what}\n\n## Risk\n${brief.risk}\n\n## Look at\n${brief.lookAt.map((p) => `- ${p}`).join("\n")}\n`
        : "",
      author: f.author,
      labels: f.tags.includes("deps") ? ["dependencies"] : [],
      base: f.base,
      head_sha: f.headSha,
    },
    files,
    patchId: f.patchId ?? f.headSha,
    io: fakeInboxIO({
      diff,
      revs: { base: `refs/heads/${f.base}`, head: f.headSha },
      git: (args) => (args[0] === "log" ? fakeLog(files, now) : ""),
    }),
  };
}

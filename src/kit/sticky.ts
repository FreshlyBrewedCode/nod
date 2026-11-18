/**
 * The one sticky PR comment the verifier keeps up to date: where the PR
 * stands, what it needs from whom, why, and a deep link into the nod UI.
 * Display only; the gate never reads it. Logins are written in backticks so
 * nobody gets pinged.
 */
import { RISK_NAMES } from "./classifiers/types.ts";
import { checkTitle, type CheckSummary } from "./summary.ts";

/** First line of the sticky comment; how the verifier finds its own comment again. */
export const STICKY_MARKER = "<!-- nod:sticky -->";

/** Whether a comment body is a sticky nod comment. */
export function isStickyComment(body: string): boolean {
  return body.trimStart().startsWith(STICKY_MARKER);
}

/** The UI link for a PR: `<uiBase>/#/pr/<owner>/<repo>/<n>`. */
export function prDeepLink(uiBase: string, repo: string, pr: number): string {
  const [owner = "", name = ""] = repo.split("/");
  return `${uiBase.replace(/\/+$/, "")}/#/pr/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/${pr}`;
}

/**
 * Renders the sticky comment for a summary. `uiBase` is the UI's origin,
 * e.g. `https://ui.nod.frebreco.de`. A link never approves by itself.
 */
export function renderSticky(
  summary: CheckSummary,
  options: { uiBase: string; maxReasons?: number },
): string {
  const { uiBase, maxReasons = 10 } = options;
  const lines: string[] = [STICKY_MARKER];
  lines.push(
    `**nod** · ${summary.category} · risk ${RISK_NAMES[summary.risk]} · ${escapeMd(checkTitle(summary))}`,
    "",
  );

  if (summary.satisfied) {
    lines.push(
      summary.requirement.level === "none" && summary.requirement.named.length === 0
        ? summary.category === "fyi"
          ? "Nobody needs to nod, but this is worth knowing about."
          : "No nod needed: this PR may merge on its own."
        : "Nothing more is needed.",
    );
  } else {
    for (const m of summary.missing) lines.push(`- Needs ${neededFrom(m, summary)}`);
  }

  const counting = summary.nods.filter((n) => n.counts && n.reviewer);
  if (counting.length) {
    lines.push(
      "",
      `Nodded: ${counting.map((n) => `\`${n.reviewer}\` (${n.role}, ${n.matched})`).join(", ")}`,
    );
  }
  const ignored = summary.nods.filter((n) => !n.counts);
  if (ignored.length) {
    const shown = ignored
      .slice(0, 5)
      .map((n) => `\`${n.reviewer ?? "unknown"}\`: ${escapeMd(n.why_not?.detail ?? "")}`);
    lines.push(
      "",
      `Not counted: ${shown.join("; ")}${ignored.length > 5 ? ` and ${ignored.length - 5} more` : ""}`,
    );
  }

  if (summary.reasons.length) {
    const reasons = summary.reasons.slice(0, maxReasons);
    lines.push(
      "",
      `<details><summary>Why: ${summary.reasons.length === 1 ? "1 reason" : `${summary.reasons.length} reasons`}</summary>`,
      "",
    );
    for (const r of reasons) {
      const risk = r.risk === undefined ? "" : ` · ${RISK_NAMES[r.risk]}`;
      lines.push(`- \`${escapeCode(r.tag)}\`${risk} · ${escapeMd(r.detail)}`);
    }
    if (summary.reasons.length > reasons.length)
      lines.push(`- and ${summary.reasons.length - reasons.length} more`);
    lines.push("", "</details>");
  }

  if (summary.errors.length) {
    lines.push("");
    for (const e of summary.errors.slice(0, 5))
      lines.push(`> ${e.source} error: ${escapeMd(e.message)}`);
  }

  lines.push(
    "",
    `[Open in nod](${prDeepLink(uiBase, summary.repo, summary.pr)}) to look and nod. A link never approves by itself.`,
  );
  return `${lines.join("\n")}\n`;
}

function neededFrom(m: CheckSummary["missing"][number], summary: CheckSummary): string {
  if (m.kind === "named") return `a nod from \`${m.login}\``;
  if (m.kind === "self") return `a nod from \`${m.login}\` (self) or anyone enrolled`;
  const peers = summary.signers.filter((s) => s.toLowerCase() !== summary.author.toLowerCase());
  if (peers.length === 0) return "a peer nod, but nobody other than the author is enrolled";
  return `a peer nod from ${peers.map((p) => `\`${p}\``).join(" or ")}`;
}

/** Escapes text from the PR (paths, messages) for Markdown and defuses @mentions. */
export function escapeMd(text: string): string {
  return text
    .replace(/[\\`*_{}[\]<>()#+!|~]/g, "\\$&")
    .replace(/@/g, "@\u200b")
    .replace(/\r?\n/g, " ");
}

function escapeCode(text: string): string {
  return text.replace(/`/g, "'");
}

/**
 * The one sticky PR comment the verifier keeps up to date: where the PR
 * stands, what it needs from whom, why, and a deep link into the nod UI.
 * Display only; the gate never reads it. Logins are written in backticks so
 * nobody gets pinged. The same text is the `nod` check's summary; the
 * comment itself is only posted while the check is enforced (ADR 0006).
 */
import { RISK_NAMES } from "./classifiers/types.ts";
import { GITHUB_COM, hostName } from "./host.ts";
import { checkTitle, type CheckSummary } from "./summary.ts";

/** First line of the sticky comment; how the verifier finds its own comment again. */
export const STICKY_MARKER = "<!-- nod:sticky -->";

/** Whether a comment body is a sticky nod comment. */
export function isStickyComment(body: string): boolean {
  return body.trimStart().startsWith(STICKY_MARKER);
}

/**
 * The path segments naming a repo in a deep link: `<owner>/<repo>` on
 * github.com, `<host>/<owner>/<repo>` on any other host. A link without a
 * host is a github.com link, so a link for one host can never match a repo
 * of the same name on another.
 */
function linkRepo(repo: string, host: string | undefined): string {
  const [owner = "", name = ""] = repo.split("/");
  const path = `${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;
  if (host === undefined) return path;
  const h = hostName(host);
  if (!h) throw new Error(`not a GitHub host: ${host}`);
  return h === GITHUB_COM ? path : `${encodeURIComponent(h)}/${path}`;
}

/**
 * The UI link for a PR: `<uiBase>/#/pr/<owner>/<repo>/<n>`, and
 * `<uiBase>/#/pr/<host>/<owner>/<repo>/<n>` when `host` (a host name or the
 * server URL, e.g. `GITHUB_SERVER_URL`) is not github.com.
 */
export function prDeepLink(uiBase: string, repo: string, pr: number, host?: string): string {
  return `${uiBase.replace(/\/+$/, "")}/#/pr/${linkRepo(repo, host)}/${pr}`;
}

/**
 * The UI link for a batch: `<uiBase>/#/batch/[<host>/]<owner>/<repo>/<n>,<n>,…`
 * (the host as in {@link prDeepLink}). It opens the batch dialog's review
 * step for the PRs that still need the reader; like every link it never
 * approves by itself. Duplicates are dropped; the order is kept.
 */
export function batchDeepLink(
  uiBase: string,
  repo: string,
  prs: ReadonlyArray<number>,
  host?: string,
): string {
  const numbers = [...new Set(prs)].filter((n) => Number.isInteger(n) && n > 0);
  return `${uiBase.replace(/\/+$/, "")}/#/batch/${linkRepo(repo, host)}/${numbers.join(",")}`;
}

/**
 * Renders the sticky comment for a summary. `uiBase` is the UI's origin,
 * e.g. `https://ui.nod.frebreco.de`; `host` the repo's GitHub host or server
 * URL (`GITHUB_SERVER_URL`), which the link names unless it is github.com. A
 * link never approves by itself.
 */
export function renderSticky(
  summary: CheckSummary,
  options: { uiBase: string; host?: string; maxReasons?: number },
): string {
  const { uiBase, host, maxReasons = 10 } = options;
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
  const approvals = summary.approvals ?? [];
  const approved = approvals.filter((a) => a.counts);
  if (approved.length) {
    lines.push("", `Approved on GitHub: ${approved.map((a) => `\`${a.reviewer}\``).join(", ")}`);
  }
  const ignored = [
    ...summary.nods
      .filter((n) => !n.counts)
      .map((n) => `\`${n.reviewer ?? "unknown"}\`: ${escapeMd(n.why_not?.detail ?? "")}`),
    ...approvals
      .filter((a) => !a.counts)
      .map((a) => `\`${a.reviewer}\`'s approval: ${escapeMd(a.why_not?.detail ?? "")}`),
  ];
  if (ignored.length) {
    lines.push(
      "",
      `Not counted: ${ignored.slice(0, 5).join("; ")}${ignored.length > 5 ? ` and ${ignored.length - 5} more` : ""}`,
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

  if (summary.enforcement?.enforced === false) {
    lines.push(
      "",
      `Not enforced: \`${escapeCode(summary.base)}\` does not require the \`nod\` check, so it never blocks a merge. \`nod init --ruleset\` makes it required.`,
    );
  } else if (summary.enforcement?.by === "unknown" && summary.enforcement.detail) {
    lines.push(
      "",
      `Treated as enforced: whether \`${escapeCode(summary.base)}\` requires the \`nod\` check is unknown (${escapeMd(summary.enforcement.detail)}).`,
    );
  }

  lines.push(
    "",
    `[Open in nod](${prDeepLink(uiBase, summary.repo, summary.pr, host)}) to look and nod. A link never approves by itself.`,
  );
  return `${lines.join("\n")}\n`;
}

function neededFrom(m: CheckSummary["missing"][number], summary: CheckSummary): string {
  if (m.kind === "named")
    return m.approval ? `an approval or a nod from \`${m.login}\`` : `a nod from \`${m.login}\``;
  if (m.kind === "self")
    return m.approval
      ? `a nod from \`${m.login}\` (self) or anyone enrolled, or an approval from anyone with write access`
      : `a nod from \`${m.login}\` (self) or anyone enrolled`;
  const peers = summary.signers.filter((s) => s.toLowerCase() !== summary.author.toLowerCase());
  const nodFrom = peers.length
    ? `a peer nod from ${peers.map((p) => `\`${p}\``).join(" or ")}`
    : "";
  if (m.approval)
    return `an approval from anyone with write access but the author${nodFrom ? `, or ${nodFrom}` : ""}`;
  if (!nodFrom) return "a peer nod, but nobody other than the author is enrolled";
  return nodFrom;
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

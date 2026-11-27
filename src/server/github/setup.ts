/**
 * Onboarding against a real repo: is it set up (the checklist), is my key
 * enrolled (ADR 0002: `.nod/allowed_signers` on the default branch, compared
 * by key blob), and the one-line enrolment PR.
 */

import { parseAllowedSigners } from "../../kit/sshsig.ts";
import type { Enrolment, LadderStep, PrLink, SetupCheck, SetupStatus } from "../../shared/protocol";
import { fingerprint, parsePublicKeyLine, publicKeyId, publicKeyLine } from "../signer/ssh-wire";
import { sameLogin } from "../view";
import { GitHubApiError, type GitHubApi } from "./api";

/** The branch `nod init` opens the setup PR from. */
export const SETUP_BRANCH = "nod/setup";
export const SIGNERS_PATH = ".nod/allowed_signers";
export const enrolBranch = (login: string) => `nod/enrol-${login}`;

export interface SetupFacts {
  readonly repo: string;
  readonly defaultBranch: string | null;
  /** On the default branch; null before the first read. */
  readonly files: {
    readonly policy: boolean;
    readonly verifier: boolean;
    readonly workflow: boolean;
    readonly signers: boolean;
  } | null;
  /** An active rule on the default branch requires the `nod` check; null: unknown. */
  readonly requiresNod: boolean | null;
  /**
   * GitHub refused to read the rules because the plan has none (a private
   * repo on GitHub Free): the required check cannot be turned on there.
   */
  readonly rulesRefused?: boolean;
  readonly autoMerge: boolean | null;
  readonly setupPr: PrLink | null;
}

/** Whether the default branch has all of nod's setup: the policy, the verifier, the workflow, the signers. */
export function isSetUp(files: SetupFacts["files"]): boolean {
  return !!files && files.policy && files.verifier && files.workflow && files.signers;
}

/**
 * The repo's ladder step (ADR 0006): `inbox` until the whole setup is on the
 * default branch, then `shared-policy`, `enforced` once a rule requires the
 * `nod` check (unknown reads as not: the step is for display, the verifier
 * decides what the check concludes).
 */
export function ladderStep(f: Pick<SetupFacts, "files" | "requiresNod">): LadderStep {
  if (!isSetUp(f.files)) return "inbox";
  return f.requiresNod ? "enforced" : "shared-policy";
}

/** The checklist of onboarding step 2. */
export function setupStatusOf(f: SetupFacts): SetupStatus {
  const files = f.files;
  const pending = f.setupPr ? `in #${f.setupPr.number}` : null;
  const ready = isSetUp(files);
  const file = (id: SetupCheck["id"], label: string, detail: string, have: boolean | undefined) =>
    ({
      id,
      label,
      detail,
      state: have === undefined ? "unknown" : have ? "ok" : pending ? "pending" : "missing",
      note: have === undefined ? null : have ? null : (pending ?? "missing"),
    }) satisfies SetupCheck;
  const branch = f.defaultBranch ?? "the default branch";
  const checks: SetupCheck[] = [
    file("policy", "Policy file", ".nod/policy.ts", files?.policy),
    file("verifier", "Verifier", ".nod/verify.ts", files?.verifier),
    file("workflow", "Verifier workflow", ".github/workflows/nod.yml", files?.workflow),
    file("allowed-signers", "Allowed signers", SIGNERS_PATH, files?.signers),
    f.rulesRefused
      ? {
          id: "required-check",
          label: `Required check on ${branch}`,
          detail:
            "rulesets on private repositories need GitHub Pro, Team or Enterprise; this plan has none",
          state: "missing",
          note: "needs a paid plan",
        }
      : {
          id: "required-check",
          label: `Required check on ${branch}`,
          detail: "a ruleset requires the nod check (required approvals 0)",
          state: f.requiresNod === null ? "unknown" : f.requiresNod ? "ok" : "missing",
          note:
            f.requiresNod === null
              ? null
              : f.requiresNod
                ? null
                : ready
                  ? "run nod init --ruleset"
                  : "after merge",
        },
    {
      id: "auto-merge",
      label: "Auto-merge allowed",
      detail: "Settings → General → Pull Requests",
      state: f.autoMerge === null ? "unknown" : f.autoMerge ? "ok" : "missing",
      note: f.autoMerge === false ? (ready ? "run nod init --ruleset" : "after merge") : null,
    },
  ];
  return {
    repo: f.repo,
    state: ready ? "ready" : f.setupPr ? "pending" : "missing",
    checks,
    setupPr: ready ? null : f.setupPr,
    step: ladderStep(f),
  };
}

/** The logins a key (any comment, any spelling of its base64) is enrolled as in `text`. */
export function principalsOf(text: string, publicKey: string): string[] {
  const id = publicKeyId(publicKey);
  return parseAllowedSigners(text)
    .filter((s) => publicKeyId(`${s.keyType} ${s.key}`) === id)
    .flatMap((s) => s.principals);
}

/**
 * Whether the repo trusts my key as me: `active` when the default branch's
 * file lists it under my login; `pending` when an open PR's version of the
 * file does; else `not-enrolled`. A key listed under another login does not
 * count: a nod with `reviewer: me` would not verify.
 */
export function enrolmentOf(input: {
  readonly publicKey: string;
  readonly me: string | null;
  readonly signers: string | null;
  readonly candidates: ReadonlyArray<{ readonly pr: PrLink; readonly text: string }>;
}): Enrolment {
  const { publicKey, me } = input;
  if (!me) return { state: "not-enrolled" };
  const listed = (text: string) => principalsOf(text, publicKey).some((p) => sameLogin(p, me));
  if (input.signers !== null && listed(input.signers)) return { state: "active" };
  const pr = input.candidates.find((c) => listed(c.text))?.pr;
  return pr ? { state: "pending", pr } : { state: "not-enrolled" };
}

/** `<login> namespaces="nod" ssh-ed25519 AAAA…`: the line the enrolment PR adds. */
export function signerLine(login: string, publicKey: string): string {
  return `${login} namespaces="nod" ${publicKeyLine(parsePublicKeyLine(publicKey))}`;
}

/** Whether an active rule on `branch` requires a status check named `nod`. */
export async function requiresNodCheck(
  api: GitHubApi,
  repo: string,
  branch: string,
): Promise<boolean> {
  const { data } = await api.rest<
    Array<{
      type: string;
      parameters?: { required_status_checks?: Array<{ context: string }> };
    }>
  >("GET", `/repos/${repo}/rules/branches/${encodeURIComponent(branch)}`);
  return (data ?? []).some(
    (r) =>
      r.type === "required_status_checks" &&
      (r.parameters?.required_status_checks ?? []).some((c) => c.context === "nod"),
  );
}

export interface EnrolInput {
  readonly repo: string;
  readonly defaultBranch: string;
  readonly login: string;
  readonly publicKey: string;
  /** The commit's author and committer: the clone's git identity; null: GitHub's default. */
  readonly identity: { readonly name: string; readonly email: string } | null;
}

/** The enrolment PR's description: a brief, as an agent would write it. */
export function enrolBody(login: string, publicKey: string): string {
  const fp = fingerprint(parsePublicKeyLine(publicKey));
  return [
    `**What** Adds one line to \`${SIGNERS_PATH}\`: the nod signing key of \`${login}\` (\`${fp}\`).`,
    "",
    `**Why** So \`${login}\` can nod pull requests here. The verifier trusts only the keys in this file on the default branch (nod ADR 0002).`,
    "",
    `**Risk:** high: it changes \`.nod/**\`, the trust root, so the policy asks for a teammate's (peer) nod. Before you nod, check with \`${login}\`, in person or on another channel, that \`${fp}\` is the fingerprint their \`nod key show\` prints.`,
    "",
    "**Verified** Opened by `nod serve` from the key it holds; the line is exactly that key's public half.",
    "",
    `**Look at** \`${SIGNERS_PATH}\`: one added line, nothing removed.`,
    "",
  ].join("\n");
}

const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");

/**
 * Opens (or reuses) the enrolment PR from `nod/enrol-<login>` through the
 * contents API: no clone, no checkout. Re-running it is harmless: the branch
 * is reset to the default branch's tip and gets the one line again.
 */
export async function openEnrolPr(api: GitHubApi, input: EnrolInput): Promise<PrLink> {
  const { repo, defaultBranch, login, publicKey } = input;
  const branch = enrolBranch(login);
  const line = signerLine(login, publicKey);
  const ref = await api.rest<{ object: { sha: string } }>(
    "GET",
    `/repos/${repo}/git/ref/heads/${encodeURIComponent(defaultBranch)}`,
  );
  const tip = ref.data.object.sha;
  const file = await api.rest<{ sha: string; content: string }>(
    "GET",
    `/repos/${repo}/contents/${SIGNERS_PATH}?ref=${encodeURIComponent(defaultBranch)}`,
  );
  const text = Buffer.from(file.data.content, "base64").toString("utf8");
  const next = `${text}${text === "" || text.endsWith("\n") ? "" : "\n"}${line}\n`;

  try {
    await api.rest("POST", `/repos/${repo}/git/refs`, { ref: `refs/heads/${branch}`, sha: tip });
  } catch (error) {
    if (!(error instanceof GitHubApiError) || error.status !== 422) throw error;
    // The branch is left from an earlier try: start it over from the tip.
    await api.rest("PATCH", `/repos/${repo}/git/refs/heads/${branch}`, { sha: tip, force: true });
  }
  const who = input.identity ? { author: input.identity, committer: input.identity } : {};
  await api.rest("PUT", `/repos/${repo}/contents/${SIGNERS_PATH}`, {
    message: `chore(nod): enrol the signing key of ${login}\n\nAdds ${fingerprint(parsePublicKeyLine(publicKey))} for ${login} to ${SIGNERS_PATH}.`,
    content: b64(next),
    sha: file.data.sha,
    branch,
    ...who,
  });
  const owner = repo.split("/")[0]!;
  const open = await api.rest<Array<{ number: number; html_url: string }>>(
    "GET",
    `/repos/${repo}/pulls?state=open&head=${encodeURIComponent(`${owner}:${branch}`)}`,
  );
  const existing = open.data?.[0];
  if (existing) return { number: existing.number, url: existing.html_url };
  const pr = await api.rest<{ number: number; html_url: string }>("POST", `/repos/${repo}/pulls`, {
    title: `chore(nod): enrol the signing key of ${login}`,
    head: branch,
    base: defaultBranch,
    body: enrolBody(login, publicKey),
  });
  return { number: pr.data.number, url: pr.data.html_url };
}

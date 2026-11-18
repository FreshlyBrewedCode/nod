/**
 * The files `nod init` adds to a repository, rendered from `templates/`:
 * the repo-owned `.nod/` (policy, classifiers, verifier, trust root, the
 * kit pin) and `.github/workflows/nod.yml`. Pure apart from
 * {@link loadTemplates}, which reads the template folder.
 */
import { readdir, readFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";

import { LOGIN_RE } from "../kit/nod.ts";

/** `templates/` at the package root (also in the published package). */
export const TEMPLATES_DIR = join(import.meta.dir, "..", "..", "templates");

/** The npm package the templates depend on. */
export const KIT_PACKAGE = "@frebreco/nod";

/** The repository the kit is installed from before it is on npm. */
export const KIT_GIT_REPO = "FreshlyBrewedCode/nod";

/** One template file: its path inside `templates/` and its text. */
export interface Template {
  path: string;
  content: string;
}

/** One file to write into the target repo. */
export interface SetupFile {
  /** Path relative to the repo root, with `/` separators. */
  path: string;
  content: string;
}

/** A first signer for `.nod/allowed_signers`. */
export interface Signer {
  /** GitHub login: the principal. */
  login: string;
  /** `ssh-ed25519 AAAA…` (a comment, if any, is dropped). */
  publicKey: string;
}

/** Reads every file under `dir` (default {@link TEMPLATES_DIR}), dot folders included. */
export async function loadTemplates(dir: string = TEMPLATES_DIR): Promise<Template[]> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  const out: Template[] = [];
  for (const e of entries) {
    if (!e.isFile()) continue;
    const full = join(e.parentPath, e.name);
    out.push({
      path: relative(dir, full).split(sep).join("/"),
      content: await readFile(full, "utf8"),
    });
  }
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

/** Template paths that are stored under another name (npm drops files named `.gitignore`). */
const RENAMES: Record<string, string> = { ".nod/gitignore": ".nod/.gitignore" };

/** The placeholder in `templates/.nod/package.json`. */
export const KIT_SPEC_PLACEHOLDER = "__NOD_KIT_SPEC__";

/**
 * Renders the setup: every template, `.nod/package.json` pinned to
 * `kitSpec`, and one `allowed_signers` line per signer.
 */
export function renderSetup(
  templates: readonly Template[],
  options: { kitSpec: string; signers: readonly Signer[] },
): SetupFile[] {
  const { kitSpec, signers } = options;
  if (!kitSpec || /\s|"/.test(kitSpec)) throw new Error(`not a usable kit spec: ${kitSpec}`);
  const files: SetupFile[] = [];
  for (const t of templates) {
    const path = RENAMES[t.path] ?? t.path;
    let content = t.content;
    if (path === ".nod/package.json") {
      if (!content.includes(KIT_SPEC_PLACEHOLDER))
        throw new Error("templates/.nod/package.json has no kit placeholder");
      content = content.replace(KIT_SPEC_PLACEHOLDER, kitSpec);
    }
    if (path === ".nod/allowed_signers" && signers.length) {
      content = `${content.trimEnd()}\n\n${signers.map(allowedSignersLine).join("\n")}\n`;
    }
    files.push({ path, content });
  }
  for (const needed of [
    ".nod/policy.ts",
    ".nod/verify.ts",
    ".nod/allowed_signers",
    ".nod/package.json",
    ".github/workflows/nod.yml",
  ]) {
    if (!files.some((f) => f.path === needed)) throw new Error(`the templates lack ${needed}`);
  }
  return files;
}

const KEY_RE = /^(ssh-ed25519|sk-ssh-ed25519@openssh\.com) (AAAA[A-Za-z0-9+/]+={0,2})(?:\s.*)?$/;

/** The `allowed_signers` line for a signer: `<login> namespaces="nod" <type> <key>`. */
export function allowedSignersLine(signer: Signer): string {
  const key = KEY_RE.exec(signer.publicKey.trim());
  if (!LOGIN_RE.test(signer.login)) throw new Error(`not a GitHub login: ${signer.login}`);
  if (!key) throw new Error("the signing key must be an ed25519 public key (ssh-ed25519 AAAA…)");
  return `${signer.login} namespaces="nod" ${key[1]} ${key[2]}`;
}

/**
 * Parses `--signer "<login> <ssh-ed25519 AAAA…> [comment]"`, or a public key
 * file's text with the login given separately (`--signer-key`).
 */
export function parseSigner(text: string, login?: string): Signer {
  const t = text.trim();
  if (login !== undefined) {
    const signer = { login, publicKey: t.split("\n")[0]!.trim() };
    allowedSignersLine(signer);
    return signer;
  }
  const m = /^(\S+)\s+(.+)$/.exec(t);
  if (!m) throw new Error('--signer is "<login> <ssh-ed25519 AAAA…>"');
  const signer = { login: m[1]!, publicKey: m[2]! };
  allowedSignersLine(signer);
  return signer;
}

/** Whether a CLI version is a published one (not the `0.0.0-development` of a checkout). */
export function isRelease(version: string): boolean {
  return /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version) && !version.startsWith("0.0.0");
}

/**
 * The kit dependency `nod init` writes when `--kit` is not given: this CLI's
 * own version when it is a release (`^1.2.3`, or exactly `1.3.0-next.4`),
 * else the git commit it runs from (`github:FreshlyBrewedCode/nod#<sha>`),
 * which bun installs and pins in `bun.lock` as well.
 */
export function defaultKitSpec(version: string, gitHead: string | null): string {
  if (isRelease(version)) return version.includes("-") ? version : `^${version}`;
  if (gitHead && /^[0-9a-f]{40}$/.test(gitHead)) return `github:${KIT_GIT_REPO}#${gitHead}`;
  throw new Error(
    "this nod is neither a release nor a git checkout: pass --kit <spec>, e.g. --kit github:FreshlyBrewedCode/nod#<commit>",
  );
}

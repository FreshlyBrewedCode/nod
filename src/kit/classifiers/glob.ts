/**
 * A small glob matcher for repo paths. A pattern matches the **whole** path
 * from the repo root:
 *
 * - `*` matches within one path segment, `?` one character other than `/`;
 * - `**` matches any number of segments, including none (`docs/**`,
 *   `**\/*.md`, `src/**\/test/*`);
 * - `{a,b}` matches either alternative (no nesting);
 * - dot files match like any other file: in a risk policy a pattern that
 *   misses a file is the dangerous direction.
 *
 * `*.md` therefore only matches at the root; write `**\/*.md` for anywhere.
 */

const cache = new Map<string, RegExp>();

/** Compiles a glob to an anchored regular expression. */
export function globToRegExp(glob: string): RegExp {
  const hit = cache.get(glob);
  if (hit) return hit;
  let re = "";
  let inBraces = false;
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === "*") {
      if (glob[i + 1] === "*") {
        const atStart = i === 0 || glob[i - 1] === "/";
        if (atStart && glob[i + 2] === "/") {
          re += "(?:[^/]*/)*"; // `**/`: zero or more whole segments
          i += 2;
        } else {
          re += ".*"; // any other `**`, e.g. a trailing one: everything below
          i += 1;
        }
      } else re += "[^/]*";
    } else if (c === "?") re += "[^/]";
    else if (c === "{" && !inBraces) {
      inBraces = true;
      re += "(?:";
    } else if (c === "}" && inBraces) {
      inBraces = false;
      re += ")";
    } else if (c === "," && inBraces) re += "|";
    else re += c.replace(/[.+^$()|[\]\\]/g, "\\$&");
  }
  if (inBraces) re += ")";
  const compiled = new RegExp(`^${re}$`);
  cache.set(glob, compiled);
  return compiled;
}

/** Whether `path` matches `glob` (see the module comment for the syntax). */
export function matchGlob(glob: string, path: string): boolean {
  return globToRegExp(glob).test(path.replace(/^\.?\//, ""));
}

/** Whether `path` matches any of `globs`. */
export function matchAny(globs: readonly string[], path: string): boolean {
  return globs.some((g) => matchGlob(g, path));
}

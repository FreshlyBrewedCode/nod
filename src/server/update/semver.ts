/**
 * Semver, by hand (no dependency): parse, compare, and the channel a version
 * belongs to. Enough for nod's own versions (`X.Y.Z` and `X.Y.Z-next.N`), and
 * correct for any valid semver 2.0.0 string: pre-releases order by their
 * dot-separated identifiers (numbers numerically, below words; a shorter list
 * below a longer one that starts the same), and build metadata (`+…`) is
 * ignored.
 */

export interface Semver {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  /** Pre-release identifiers: `0.2.0-next.5` → `["next", 5]`; empty for a stable version. */
  readonly pre: readonly (string | number)[];
}

const SEMVER =
  /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+[0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*)?$/;

/** The parts of a version string (a leading `v` is allowed), or null when it is not semver. */
export function parseSemver(version: string): Semver | null {
  const match = SEMVER.exec(version.trim());
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    pre:
      match[4] === undefined
        ? []
        : match[4].split(".").map((id) => (/^\d+$/.test(id) ? Number(id) : id)),
  };
}

/** `1.2.3`, `1.2.3-next.4`: the string without a leading `v` or build metadata. */
export function normalizeVersion(version: string): string | null {
  const parsed = parseSemver(version);
  if (!parsed) return null;
  const pre = parsed.pre.length ? `-${parsed.pre.join(".")}` : "";
  return `${parsed.major}.${parsed.minor}.${parsed.patch}${pre}`;
}

function comparePre(a: readonly (string | number)[], b: readonly (string | number)[]): number {
  // A version without a pre-release is higher than one with.
  if (a.length === 0 || b.length === 0) return a.length === b.length ? 0 : a.length === 0 ? 1 : -1;
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const x = a[i]!;
    const y = b[i]!;
    if (x === y) continue;
    if (typeof x === "number" && typeof y === "number") return x < y ? -1 : 1;
    // Numbers are lower than words; words compare as strings.
    if (typeof x === "number") return -1;
    if (typeof y === "number") return 1;
    return x < y ? -1 : 1;
  }
  return a.length === b.length ? 0 : a.length < b.length ? -1 : 1;
}

/** Negative when `a` is older than `b`, 0 when equal, positive when newer. Throws on a non-semver string. */
export function compareSemver(a: string | Semver, b: string | Semver): number {
  const x = typeof a === "string" ? parseSemver(a) : a;
  const y = typeof b === "string" ? parseSemver(b) : b;
  if (!x || !y) throw new Error(`not a semver version: ${!x ? String(a) : String(b)}`);
  return (
    Math.sign(x.major - y.major) ||
    Math.sign(x.minor - y.minor) ||
    Math.sign(x.patch - y.patch) ||
    comparePre(x.pre, y.pre)
  );
}

/** A pre-release (`X.Y.Z-next.N`) is a `next` build; everything else is stable. */
export function isPrerelease(version: string): boolean {
  const parsed = parseSemver(version);
  return !!parsed && parsed.pre.length > 0;
}

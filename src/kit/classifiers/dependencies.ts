import { matchAny } from "./glob.ts";
import { count, preview } from "./paths.ts";
import type { Classifier, Risk } from "./types.ts";

/** Dependency manifests: where dependencies are declared. */
export const DEPENDENCY_MANIFESTS: readonly string[] = [
  "**/package.json",
  "**/Cargo.toml",
  "**/go.mod",
  "**/pyproject.toml",
  "**/requirements*.txt",
  "**/Pipfile",
  "**/Gemfile",
  "**/composer.json",
  "**/mix.exs",
  "**/pubspec.yaml",
  "**/Podfile",
  "**/*.csproj",
  "**/flake.nix",
  "**/deno.json",
];

/** Lockfiles: what dependencies resolve to. */
export const DEPENDENCY_LOCKFILES: readonly string[] = [
  "**/bun.lock",
  "**/bun.lockb",
  "**/package-lock.json",
  "**/npm-shrinkwrap.json",
  "**/yarn.lock",
  "**/pnpm-lock.yaml",
  "**/deno.lock",
  "**/Cargo.lock",
  "**/go.sum",
  "**/poetry.lock",
  "**/uv.lock",
  "**/Pipfile.lock",
  "**/Gemfile.lock",
  "**/composer.lock",
  "**/flake.lock",
  "**/mix.lock",
  "**/pubspec.lock",
  "**/Podfile.lock",
  "**/packages.lock.json",
];

/** Options for {@link dependencies}. */
export interface DependenciesOptions {
  manifests?: readonly string[];
  lockfiles?: readonly string[];
  /** Risk for a PR that changes only dependency files (default 1). */
  onlyRisk?: Risk;
  /** Risk for a PR that changes dependencies and code together (default 2). */
  mixedRisk?: Risk;
}

/**
 * Notices dependency changes. Gives one finding when a manifest or lockfile
 * changed: `deps-only` when nothing else did (a typical bump), `deps` when
 * code changed along with them.
 */
export function dependencies(options: DependenciesOptions = {}): Classifier {
  const globs = [
    ...(options.manifests ?? DEPENDENCY_MANIFESTS),
    ...(options.lockfiles ?? DEPENDENCY_LOCKFILES),
  ];
  const { onlyRisk = 1, mixedRisk = 2 } = options;
  return ({ files }) => {
    const deps = files.filter((f) => matchAny(globs, f.path)).map((f) => f.path);
    if (deps.length === 0) return [];
    const others = files.length - deps.length;
    if (others === 0) {
      return [
        {
          classifier: "dependencies",
          tag: "deps-only",
          risk: onlyRisk,
          detail: `only dependencies: ${preview(deps)}`,
        },
      ];
    }
    return [
      {
        classifier: "dependencies",
        tag: "deps",
        risk: mixedRisk,
        detail: `dependencies (${preview(deps)}) change along with ${count(others, "other file")}`,
      },
    ];
  };
}

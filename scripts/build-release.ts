#!/usr/bin/env bun
// Stages the npm package semantic-release publishes, under `dist/npm/nod/`.
// The repo-root `package.json` stays `"private": true` permanently: only what
// this script generates ever reaches the registry, so publishing the workspace
// by accident is structurally impossible. Modelled on canvas's.
//
// The package is `nod serve` and the `@frebreco/nod/kit` helpers. It ships raw
// TypeScript and requires Bun at runtime; `bin/nod.js` is the guard and
// launcher. The web app's sources are not in it: the release workflow deploys
// the web app to ui.nod.frebreco.de, and `src/server/web-url.ts` picks the
// build matching the version stamped here. So only `src/cli.ts`, `src/server/`,
// `src/shared/`, `src/kit/` and `src/init/` are staged, plus `templates/` (what
// `nod init` writes into a repo), and the manifest carries only the
// dependencies the sources need, not React and friends. What it does carry is
// this version's built web app, under `web/` with base `/`: the one
// `nod serve --allow-host` serves on the named host (ADR 0005).
//
// The version is stamped into the staged `package.json`, and into the
// `const VERSION = "0.0.0-development";` placeholder of the staged `src/cli.ts`.
//
// Usage: bun scripts/build-release.ts [version] [--smoke-test]
// `version` defaults to "0.0.0-dev" — enough to prove the package stages.

import { chmod, cp, mkdir, mkdtemp, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { builtinModules } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dir, "..");
const DIST = join(REPO_ROOT, "dist", "npm");
const PKG = join(DIST, "nod");
const NAME = "@frebreco/nod";

// Matches the GitHub remote character for character — npm rejects an OIDC
// publish with an opaque error when the manifest's `repository.url` disagrees
// with the trusted publisher's repository.
const REPOSITORY_URL = "git+https://github.com/FreshlyBrewedCode/nod.git";
const DESCRIPTION =
  "Steer your team's attention across agent-written pull requests, and let humans nod them through with a signed attestation, so agents can merge on their own.";

/** What `nod serve` and the kit are made of, relative to the repo root. */
const SOURCES = ["src/cli.ts", "src/server", "src/shared", "src/kit", "src/init", "templates"];

const VERSION = process.argv[2] ?? "0.0.0-dev";
const SMOKE_TEST = process.argv.includes("--smoke-test");

function fail(message: string): never {
  console.error(`nod: ${message}`);
  process.exit(1);
}

function run(cmd: string[], cwd: string = REPO_ROOT): void {
  const result = Bun.spawnSync({ cmd, cwd, stdout: "inherit", stderr: "inherit" });
  if (result.exitCode !== 0) fail(`\`${cmd.join(" ")}\` failed.`);
}

/** `@scope/name/sub/path` -> `@scope/name`, `name/sub` -> `name`. */
function packageOf(specifier: string): string {
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0]!;
}

/**
 * The root dependencies the staged sources need: every bare import, and the
 * peers of those that the root pins too. An import the root does not declare
 * fails the build here rather than on a user's machine.
 */
async function runtimeDependencies(
  declared: Record<string, string>,
): Promise<Record<string, string>> {
  const transpiler = new Bun.Transpiler({ loader: "ts" });
  const needed = new Set<string>();
  for await (const file of new Bun.Glob("**/*.ts").scan({ cwd: join(PKG, "src") })) {
    // `scanImports` rejects the shebang `cli.ts` may start with.
    const code = (await Bun.file(join(PKG, "src", file)).text()).replace(/^#!.*/, "");
    for (const { path } of transpiler.scanImports(code)) {
      if (path.startsWith(".") || path.startsWith("node:") || path.startsWith("bun")) continue;
      if (builtinModules.includes(path)) continue;
      // Its own name: the inbox fixture imports the kit as a user's inbox does, and the inbox
      // subprocess maps that to this package's own kit (ADR 0009).
      if (packageOf(path) === NAME) continue;
      needed.add(packageOf(path));
    }
  }

  for (const name of [...needed]) {
    const manifest = (await Bun.file(
      join(REPO_ROOT, "node_modules", name, "package.json"),
    ).json()) as { peerDependencies?: Record<string, string> };
    for (const peer of Object.keys(manifest.peerDependencies ?? {})) {
      if (peer in declared) needed.add(peer);
    }
  }

  const dependencies: Record<string, string> = {};
  for (const name of [...needed].sort()) {
    const range = declared[name];
    if (range === undefined) fail(`the staged sources need "${name}", which package.json lacks.`);
    dependencies[name] = range;
  }
  return dependencies;
}

/**
 * Installs the staged package into `work` the way a registry install lays it
 * out: nod as a *real directory* under `node_modules`, and beside it only
 * the dependencies its manifest declares. A symlink back into this repo would
 * let every lookup walk out of `dist/` into the repo's own `node_modules`, so
 * an undeclared dependency would still resolve and the test would pass.
 */
async function install(work: string, dependencies: Record<string, string>): Promise<string> {
  const modules = join(work, "node_modules");
  await mkdir(join(modules, "@frebreco"), { recursive: true });
  for (const name of Object.keys(dependencies)) {
    if (name.startsWith("@")) await mkdir(join(modules, name.split("/")[0]!), { recursive: true });
    await symlink(join(REPO_ROOT, "node_modules", name), join(modules, name), "dir");
  }
  const installed = join(modules, "@frebreco", "nod");
  await cp(PKG, installed, { recursive: true });
  return installed;
}

/** `nod --version` from the installed copy prints the version stamped here. */
function smokeTestVersion(installed: string, work: string): void {
  const result = Bun.spawnSync({
    // Straight to cli.ts: `import.meta.main` is false behind the launcher's import, so
    // bin/nod.js prints nothing yet (to be fixed in src/cli.ts, not staging).
    cmd: [process.execPath, join(installed, "src", "cli.ts"), "--version"],
    cwd: work,
    stdout: "pipe",
    stderr: "pipe",
  });
  const printed = result.stdout.toString().trim();
  if (result.exitCode !== 0 || printed !== VERSION) {
    fail(`\`nod --version\` printed "${printed}", expected "${VERSION}".\n${result.stderr}`);
  }
}

/**
 * A consumer's `.nod/verify.ts` imports the kit by its package name, and an
 * `inbox.ts` the inbox entry (ADR 0009). Resolves `@frebreco/nod/kit` and
 * `@frebreco/nod/kit/inbox` from a scratch project next to the installed copy, under
 * Bun, the way the verifier's workflow runs it.
 */
async function smokeTestKit(work: string): Promise<void> {
  const project = join(work, "project");
  await mkdir(project, { recursive: true });
  const probe = join(project, "probe.ts");
  await writeFile(
    probe,
    'import * as kit from "@frebreco/nod/kit";\nimport * as inbox from "@frebreco/nod/kit/inbox";\nif (kit.KIT_VERSION === undefined) throw new Error("no KIT_VERSION");\nif (inbox.INBOX_VERSION === undefined) throw new Error("no INBOX_VERSION");\nconsole.log("kit ok");\n',
  );
  const result = Bun.spawnSync({
    cmd: [process.execPath, probe],
    cwd: project,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0 || !result.stdout.toString().includes("kit ok")) {
    fail(`\`@frebreco/nod/kit\` does not resolve for a consumer.\n${result.stderr}`);
  }
}

/**
 * `nod init` renders its files from the staged `templates/`, dot folders
 * included: the repo-owned `.nod/` and the workflow.
 */
async function smokeTestTemplates(installed: string): Promise<void> {
  const { loadTemplates, renderSetup } = (await import(
    join(installed, "src", "init", "setup-files.ts")
  )) as typeof import("../src/init/setup-files.ts");
  const files = renderSetup(await loadTemplates(join(installed, "templates")), {
    kitSpec: `^${VERSION}`,
    signers: [],
  });
  const paths = files.map((f) => f.path);
  for (const p of [".nod/verify.ts", ".nod/.gitignore", ".github/workflows/nod.yml"])
    if (!paths.includes(p)) fail(`the staged templates do not render ${p}.`);
}

/**
 * The built web app `nod serve --allow-host` serves: it is in the package,
 * every asset its page loads is there, and the staged server finds it on its
 * own (`defaultWebRoot`).
 */
async function smokeTestWebApp(installed: string): Promise<void> {
  const web = join(installed, "web");
  const index = Bun.file(join(web, "index.html"));
  if (!(await index.exists())) fail("the built web app (web/index.html) was not staged.");
  const assets = [...(await index.text()).matchAll(/(?:src|href)="\/(assets\/[^"]+)"/g)];
  if (assets.length === 0) fail("web/index.html loads no /assets/: was it built with base /?");
  for (const [, path] of assets)
    if (!(await Bun.file(join(web, path!)).exists())) fail(`web/${path} was not staged.`);
  const { defaultWebRoot } = (await import(
    join(installed, "src", "server", "static-files.ts")
  )) as typeof import("../src/server/static-files.ts");
  if (defaultWebRoot() !== web) fail(`nod serve looks for its web app in ${defaultWebRoot()}.`);
}

/**
 * Checks the channel the staged CLI opens: `src/server/web-url.ts` must exist
 * and export `defaultWebUrl(version)`: the stable URL for `X.Y.Z`, the
 * `/next` one for `X.Y.Z-next.N`, a local one for no version.
 */
async function smokeTestWebUrl(installed: string): Promise<void> {
  const file = join(installed, "src", "server", "web-url.ts");
  if (!(await Bun.file(file).exists())) fail("src/server/web-url.ts was not staged.");
  const { defaultWebUrl } = (await import(file)) as {
    defaultWebUrl: (version: string | undefined) => string;
  };
  const stable = "https://ui.nod.frebreco.de";
  if (defaultWebUrl("1.0.0") !== stable || defaultWebUrl("1.0.0-next.1") !== `${stable}/next`) {
    fail("defaultWebUrl does not map stable and next versions to their channels.");
  }
}

async function smokeTest(dependencies: Record<string, string>): Promise<void> {
  const node = Bun.spawnSync(["node", join(PKG, "bin", "nod.js")], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (node.exitCode === 0 || !node.stderr.toString().includes("requires Bun")) {
    fail("the launcher did not reject Node with the 'requires Bun' message.");
  }

  const work = await mkdtemp(join(tmpdir(), "nod-smoke-"));
  try {
    const installed = await install(work, dependencies);
    smokeTestVersion(installed, work);
    run([process.execPath, join(installed, "bin", "nod.js")], work);
    await smokeTestKit(work);
    await smokeTestTemplates(installed);
    await smokeTestWebUrl(installed);
    await smokeTestWebApp(installed);
  } finally {
    await rm(work, { force: true, recursive: true });
  }
  console.log("nod: smoke test passed.");
}

const rootManifest = (await Bun.file(join(REPO_ROOT, "package.json")).json()) as {
  dependencies?: Record<string, string>;
};

console.log(`nod: staging release ${VERSION}`);

await rm(DIST, { force: true, recursive: true });
await mkdir(join(PKG, "bin"), { recursive: true });

await cp(join(REPO_ROOT, "bin", "nod.js"), join(PKG, "bin", "nod.js"));
await chmod(join(PKG, "bin", "nod.js"), 0o755);
for (const source of SOURCES) {
  await cp(join(REPO_ROOT, source), join(PKG, source), { recursive: true });
}
await cp(join(REPO_ROOT, "README.md"), join(PKG, "README.md"));
await cp(join(REPO_ROOT, "LICENSE"), join(PKG, "LICENSE"));

// Tests are development-only.
for await (const file of new Bun.Glob("**/*.test.ts").scan({ cwd: join(PKG, "src") })) {
  await rm(join(PKG, "src", file), { force: true });
}

// The web app's sources stay out; its build goes in, below.
if ((await readdir(join(PKG, "src"))).includes("web")) fail("the web app's sources were staged.");

// This version's web app, for `nod serve --allow-host`, at the root of its origin.
run([
  process.execPath,
  "x",
  "vite",
  "build",
  "--base",
  "/",
  "--outDir",
  join(PKG, "web"),
  "--emptyOutDir",
  "--logLevel",
  "warn",
]);

// Stamp the version `nod --version` prints.
const cliFile = join(PKG, "src", "cli.ts");
const cliSource = await Bun.file(cliFile).text();
const placeholder = /^const VERSION = ".*";$/m;
if (!placeholder.test(cliSource)) fail('src/cli.ts has no `const VERSION = "…";` line to stamp.');
await Bun.write(cliFile, cliSource.replace(placeholder, `const VERSION = "${VERSION}";`));

const dependencies = await runtimeDependencies(rootManifest.dependencies ?? {});

const manifest = {
  name: NAME,
  version: VERSION,
  description: DESCRIPTION,
  license: "MIT",
  type: "module",
  bin: { nod: "bin/nod.js" },
  // Raw TypeScript: a consumer running Bun imports it as is.
  exports: { "./kit": "./src/kit/index.ts", "./kit/inbox": "./src/kit/inbox/index.ts" },
  engines: { bun: ">=1.4.1" },
  homepage: "https://nod.frebreco.de",
  repository: { type: "git", url: REPOSITORY_URL },
  files: ["bin", "src", "templates", "web", "README.md", "LICENSE"],
  // A scoped package is private to its org unless published as public.
  publishConfig: { access: "public" },
  dependencies,
};

await Bun.write(join(PKG, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);

if (SMOKE_TEST) await smokeTest(dependencies);

console.log(`nod: staged ${NAME}@${VERSION} in ${PKG}`);

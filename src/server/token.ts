/**
 * The token that keeps other pages off the socket. A WebSocket is not
 * subject to CORS, so any website could open one to `ws://127.0.0.1`: only
 * the token, which rides in the host link's fragment, tells our page apart.
 *
 * It is stable across restarts (a file under the config dir, mode 0600), so
 * a paired browser, its bookmarks and the deep links it opens keep working
 * after `nod serve` restarts. `--new-token` replaces it, which unpairs every
 * browser.
 */

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** `$XDG_CONFIG_HOME/nod`, else `~/.config/nod`. The signing key will live here too. */
export function configDir(
  env: Readonly<Record<string, string | undefined>> = process.env,
  home = homedir(),
): string {
  const xdg = env.XDG_CONFIG_HOME;
  return join(xdg && xdg.startsWith("/") ? xdg : join(home, ".config"), "nod");
}

export function defaultTokenFile(env?: Readonly<Record<string, string | undefined>>): string {
  return join(configDir(env), "serve-token");
}

export function newToken(): string {
  return randomBytes(32).toString("base64url");
}

const TOKEN_SHAPE = /^[A-Za-z0-9_-]{32,128}$/;

/** Read the token at `file`, or write a new one there (directory 0700, file 0600). */
export function loadOrCreateToken(file: string, options: { fresh?: boolean } = {}): string {
  if (!options.fresh && existsSync(file)) {
    const token = readFileSync(file, "utf8").trim();
    if (TOKEN_SHAPE.test(token)) {
      chmodSync(file, 0o600);
      return token;
    }
  }
  const token = newToken();
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, `${token}\n`, { mode: 0o600 });
  chmodSync(file, 0o600);
  return token;
}

/** Constant-time comparison; hashing first makes the lengths equal. */
export function tokensEqual(given: string | null, expected: string): boolean {
  if (given === null) return false;
  const a = createHash("sha256").update(given).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

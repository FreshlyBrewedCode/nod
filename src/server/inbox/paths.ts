/**
 * Where my inbox lives (ADR 0009 decision 2): `$XDG_CONFIG_HOME/nod/inbox/`,
 * with `inbox.ts` in it. No file: the built-in defaults run.
 */

import { join } from "node:path";

import { configDir } from "../token";

/** The file the folder's inbox is in. */
export const INBOX_FILE = "inbox.ts";

/** My inbox's folder: `$XDG_CONFIG_HOME/nod/inbox` (default `~/.config/nod/inbox`). */
export function inboxDir(): string {
  return join(configDir(), "inbox");
}

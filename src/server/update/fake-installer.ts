/**
 * An installer that installs nothing, for tests and `nod serve --fake`: it
 * answers like a package manager, after a delay the clock decides (none
 * without a clock). Every `run` is recorded.
 */

import type { Clock } from "../clock";
import {
  installCommand,
  isInstallTarget,
  type InstallMethod,
  type InstallResult,
  type Installer,
} from "./installer";

export interface FakeInstallerOptions {
  /** Default "npm"; null plays an installer that does not know how nod was installed. */
  readonly method?: InstallMethod | null;
  /** The install takes this long on `clock`; default instant. */
  readonly delayMs?: number;
  readonly clock?: Clock;
  /** The next installs fail, with this output (default a believable error). */
  readonly fail?: boolean | string;
}

export class FakeInstaller implements Installer {
  readonly method: InstallMethod | null;
  /** The targets `run` was called with. */
  readonly runs: string[] = [];
  fail: boolean | string;

  constructor(private readonly options: FakeInstallerOptions = {}) {
    this.method = options.method === undefined ? "npm" : options.method;
    this.fail = options.fail ?? false;
  }

  command(target: string): string | null {
    return this.method ? installCommand(this.method, target) : null;
  }

  async run(target: string): Promise<InstallResult> {
    this.runs.push(target);
    if (!this.method || !isInstallTarget(target))
      return { ok: false, code: null, output: "nod does not know how it was installed." };
    const { clock, delayMs } = this.options;
    if (clock && delayMs) await new Promise<void>((resolve) => clock.after(delayMs, resolve));
    if (this.fail) {
      return {
        ok: false,
        code: 1,
        output:
          typeof this.fail === "string"
            ? this.fail
            : `npm error code EACCES\nnpm error syscall rename\nnpm error path /usr/lib/node_modules/@frebreco/nod\nnpm error Error: EACCES: permission denied`,
      };
    }
    return {
      ok: true,
      code: 0,
      output: `added 1 package, and changed 1 package in 3s\n\n${this.command(target)}`,
    };
  }
}

/**
 * Which inbox `nod serve --fake` runs (ADR 0009, #57), so every state of the
 * personal layer is reachable without GitHub:
 *
 * - `insights`: the fixture (`fixture/inbox.ts`): the defaults, and
 *   analyzers of every block type, one running, one failing, one that times
 *   out; a +1 with a tag and a mute;
 * - `insights-error`: a copy of the fixture in a temp folder that breaks
 *   (a syntax error appended to its `inbox.ts`) once the first results are
 *   in: the error banner, with those results still on screen. Fix the file
 *   (the path is in the log) and it loads again;
 * - every other scenario: an empty temp folder, so the built-in defaults run.
 */

import { appendFileSync, cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { FakeScenario } from "../fake-source";
import { INBOX_FILE } from "./paths";
import type { InboxService } from "./service";

/** The fixture inbox, shipped with the package. */
export const FIXTURE_DIR = join(import.meta.dir, "fixture");

export interface FakeInbox {
  readonly dir: string;
  /** `insights-error`: breaks the copy once the service settled. */
  afterStart(service: InboxService, log: (line: string) => void): void;
  cleanup(): void;
}

export function fakeInbox(scenario: FakeScenario): FakeInbox {
  const tmp = mkdtempSync(join(tmpdir(), "nod-fake-inbox-"));
  const cleanup = () => rmSync(tmp, { recursive: true, force: true });
  if (scenario === "insights") return { dir: FIXTURE_DIR, afterStart: () => {}, cleanup };
  if (scenario === "insights-error") {
    cpSync(FIXTURE_DIR, tmp, { recursive: true });
    return {
      dir: tmp,
      afterStart(service, log) {
        void service.settled().then(() => {
          appendFileSync(join(tmp, INBOX_FILE), "\nexport const broken = ;\n");
          log(
            `nod serve: --scenario insights-error broke ${join(tmp, INBOX_FILE)}; fix its last line to load it again`,
          );
        });
      },
      cleanup,
    };
  }
  return { dir: tmp, afterStart: () => {}, cleanup };
}

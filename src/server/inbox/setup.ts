/**
 * My inbox for `nod serve` (ADR 0009): the runner over a folder and the
 * service over the source, started together and stopped together.
 * `start.ts` calls this; the session gets the service.
 */

import type { FakeScenario } from "../fake-source";
import { fakeInbox, type FakeInbox } from "./fake";
import { inboxDir } from "./paths";
import { InboxRunner, type RunnerOptions } from "./runner";
import { InboxService, type InboxSource } from "./service";

export interface InboxSetup {
  /** The folder; default `inboxDir()`, or with a fake scenario the fake's (`fake.ts`). */
  readonly dir?: string;
  readonly fake?: FakeScenario | null;
  readonly source: InboxSource;
  readonly log?: (line: string) => void;
  /** Test seams for the runner. */
  readonly runner?: Partial<Omit<RunnerOptions, "dir" | "log">>;
}

export interface StartedInbox {
  readonly service: InboxService;
  readonly runner: InboxRunner;
  stop(): void;
}

export function startInbox(setup: InboxSetup): StartedInbox {
  const log = setup.log ?? ((line: string) => console.error(line));
  const fake: FakeInbox | null = setup.fake && !setup.dir ? fakeInbox(setup.fake) : null;
  const dir = setup.dir ?? fake?.dir ?? inboxDir();
  const runner = new InboxRunner({ ...setup.runner, dir, log });
  const service = new InboxService({ runner, source: setup.source, log });
  runner.start();
  fake?.afterStart(service, log);
  return {
    service,
    runner,
    stop() {
      service.stop();
      runner.stop();
      fake?.cleanup();
    },
  };
}

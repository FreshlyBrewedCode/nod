/**
 * Time, injected: the server reads it only through a `Clock`, so tests can
 * move it (auto-lock, the fake source's merges, "stuck after 12 hours").
 */

export interface Clock {
  now(): number;
  /** Runs `fn` after `ms`; returns a handle for `clear`. */
  after(ms: number, fn: () => void): Timer;
  every(ms: number, fn: () => void): Timer;
}

export interface Timer {
  clear(): void;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  after(ms, fn) {
    const handle = setTimeout(fn, ms);
    return { clear: () => clearTimeout(handle) };
  },
  every(ms, fn) {
    const handle = setInterval(fn, ms);
    return { clear: () => clearInterval(handle) };
  },
};

/** A clock that only moves when told to; timers fire in time order as it passes them. */
export class ManualClock implements Clock {
  private timers: { at: number; fn: () => void; every: number | null; id: number }[] = [];
  private nextId = 0;

  constructor(private time = 0) {}

  now(): number {
    return this.time;
  }

  after(ms: number, fn: () => void): Timer {
    return this.add(ms, fn, null);
  }

  every(ms: number, fn: () => void): Timer {
    return this.add(ms, fn, Math.max(1, ms));
  }

  private add(ms: number, fn: () => void, every: number | null): Timer {
    const id = this.nextId++;
    this.timers.push({ at: this.time + Math.max(0, ms), fn, every, id });
    return { clear: () => (this.timers = this.timers.filter((t) => t.id !== id)) };
  }

  /** Move forward by `ms`, firing every timer that falls due on the way. */
  advance(ms: number): void {
    const end = this.time + ms;
    for (;;) {
      const due = this.timers
        .filter((t) => t.at <= end)
        .sort((a, b) => a.at - b.at || a.id - b.id)[0];
      if (!due) break;
      this.time = Math.max(this.time, due.at);
      if (due.every === null) this.timers = this.timers.filter((t) => t !== due);
      else due.at += due.every;
      due.fn();
    }
    this.time = end;
  }

  /** Timers still waiting. */
  get pending(): number {
    return this.timers.length;
  }
}

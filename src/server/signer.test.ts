import { expect, test } from "bun:test";

import { ManualClock } from "./clock";
import { FAKE_KEY, FakeSigner, SignerError, fakeSignature, unlockMinutes } from "./signer";

const MIN = 60_000;

const code = async (p: Promise<unknown>) => {
  try {
    await p;
    return "ok";
  } catch (error) {
    return error instanceof SignerError ? error.code : String(error);
  }
};

test("locked at start; any non-empty passphrase but `wrong` unlocks", async () => {
  const signer = new FakeSigner(new ManualClock(0));
  expect(signer.status()).toEqual({ state: "locked", key: FAKE_KEY });
  expect(await code(signer.unlock("wrong"))).toBe("bad-passphrase");
  expect(await code(signer.unlock(""))).toBe("bad-passphrase");
  expect(signer.status().state).toBe("locked");
  expect(await code(signer.unlock("correct horse"))).toBe("ok");
  expect(signer.status()).toEqual({
    state: "unlocked",
    key: FAKE_KEY,
    until: 15 * MIN,
    once: false,
  });
});

test("signing needs the key unlocked", async () => {
  const signer = new FakeSigner(new ManualClock(0));
  expect(await code(signer.sign("line"))).toBe("locked");
  await signer.unlock("pass");
  const signature = await signer.sign("line");
  expect(signature).toBe(fakeSignature("line"));
  expect(signature).toMatch(
    /^-----BEGIN SSH SIGNATURE-----\n[A-Za-z0-9+/=\n]+\n-----END SSH SIGNATURE-----$/,
  );
  expect(await signer.verify("line", signature)).toBe(true);
  expect(await signer.verify("other line", signature)).toBe(false);
});

test("auto-lock after 15 minutes by default, and tells its listeners", async () => {
  const clock = new ManualClock(1_000);
  const signer = new FakeSigner(clock);
  const seen: string[] = [];
  signer.subscribe(() => seen.push(signer.status().state));
  await signer.unlock("pass");
  clock.advance(15 * MIN - 1);
  expect(signer.status().state).toBe("unlocked");
  clock.advance(1);
  expect(signer.status().state).toBe("locked");
  expect(seen).toEqual(["unlocked", "locked"]);
  expect(clock.pending).toBe(0);
});

test("the window is clamped to 1–60 minutes; unlocking again restarts it", async () => {
  expect([
    unlockMinutes(undefined),
    unlockMinutes(0),
    unlockMinutes(5),
    unlockMinutes(600),
  ]).toEqual([15, 1, 5, 60]);
  const clock = new ManualClock(0);
  const signer = new FakeSigner(clock);
  await signer.unlock("pass", { minutes: 5 });
  clock.advance(4 * MIN);
  await signer.unlock("pass", { minutes: 5 });
  clock.advance(4 * MIN);
  expect(signer.status().state).toBe("unlocked");
  expect(clock.pending).toBe(1);
  clock.advance(MIN);
  expect(signer.status().state).toBe("locked");
});

test("a late timer does not keep it open: the time counts", async () => {
  const clock = new ManualClock(0);
  const signer = new FakeSigner(clock);
  let calls = 0;
  signer.subscribe(() => calls++);
  await signer.unlock("pass", { minutes: 1 });
  // as if the machine slept through the timer
  (clock as unknown as { time: number }).time = 2 * MIN;
  expect(signer.status().state).toBe("locked");
  expect(calls).toBe(2);
});

test("once: locks again right after the next signature", async () => {
  const signer = new FakeSigner(new ManualClock(0));
  await signer.unlock("pass", { once: true });
  expect(signer.status()).toMatchObject({ state: "unlocked", once: true });
  await signer.sign("line");
  expect(signer.status().state).toBe("locked");
});

test("once covers a batch of lines (one per repo), then locks; a second batch is refused", async () => {
  const signer = new FakeSigner(new ManualClock(0));
  await signer.unlock("pass", { once: true });
  const signatures = await signer.signLines(["a", "b"]);
  expect(signatures).toEqual([fakeSignature("a"), fakeSignature("b")]);
  expect(signer.status().state).toBe("locked");
  expect(await code(signer.signLines(["c"]))).toBe("locked");
});

test("lock() forgets the key now", async () => {
  const signer = new FakeSigner(new ManualClock(0));
  await signer.unlock("pass");
  signer.lock();
  expect(signer.status().state).toBe("locked");
});

test("no key: nothing unlocks until one is created", async () => {
  const signer = new FakeSigner(new ManualClock(0), { hasKey: false });
  expect(signer.status()).toEqual({ state: "no-key" });
  expect(await code(signer.unlock("pass"))).toBe("no-key");
  expect(await code(signer.sign("line"))).toBe("no-key");
  expect(await code(signer.createKey("short"))).toBe("weak-passphrase");
  expect(await signer.createKey("a long passphrase")).toEqual(FAKE_KEY);
  expect(signer.status().state).toBe("locked");
  expect(await code(signer.createKey("a long passphrase"))).toBe("key-exists");
});

test("errors never carry the passphrase", async () => {
  const signer = new FakeSigner(new ManualClock(0));
  try {
    await signer.unlock("wrong");
  } catch (error) {
    expect(String(error)).not.toContain("wrong");
    expect((error as Error).stack ?? "").not.toContain("wrong");
  }
});

test("a window per side: unlocking one side does not unlock the other", async () => {
  const clock = new ManualClock(0);
  const signer = new FakeSigner(clock);
  const seen: string[] = [];
  signer.subscribe(() =>
    seen.push(`${signer.status("loopback").state}/${signer.status("named-host").state}`),
  );
  await signer.unlock("pass", { side: "loopback" });
  expect(signer.status("loopback").state).toBe("unlocked");
  expect(signer.status("named-host").state).toBe("locked");
  expect(await code(signer.sign("line", "named-host"))).toBe("locked");
  expect(await code(signer.sign("line", "loopback"))).toBe("ok");

  await signer.unlock("pass", { side: "named-host", minutes: 5, once: true });
  expect(signer.status("named-host")).toMatchObject({ until: 5 * MIN, once: true });
  expect(signer.status("loopback")).toMatchObject({ until: 15 * MIN, once: false });
  // `once` and `lock` end only their own side's window.
  expect(await code(signer.sign("line", "named-host"))).toBe("ok");
  expect(signer.status("named-host").state).toBe("locked");
  expect(signer.status("loopback").state).toBe("unlocked");
  await signer.unlock("pass", { side: "named-host" });
  signer.lock("loopback");
  expect(await code(signer.sign("line", "loopback"))).toBe("locked");
  expect(await code(signer.sign("line", "named-host"))).toBe("ok");
  // The default side is loopback.
  expect(signer.status().state).toBe("locked");

  clock.advance(15 * MIN);
  expect(signer.status("named-host").state).toBe("locked");
  expect(clock.pending).toBe(0);
  expect(seen).toEqual([
    "unlocked/locked",
    "unlocked/unlocked",
    "unlocked/locked",
    "unlocked/unlocked",
    "locked/unlocked",
    "locked/locked",
  ]);
});

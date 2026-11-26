import { expect, test } from "bun:test";

import { NOTICE_STEPS, noticeFor } from "./reconnect";

test("a short drop says nothing, a longer one hints, a long one says the view is old", () => {
  expect(noticeFor(null)).toBe("none");
  expect(noticeFor(0)).toBe("none");
  expect(noticeFor(1499)).toBe("none");
  expect(noticeFor(1500)).toBe("quiet");
  expect(noticeFor(9999)).toBe("quiet");
  expect(noticeFor(10_000)).toBe("stale");
  expect(noticeFor(10 * 60_000)).toBe("stale");
});

test("the steps are in order", () => {
  const after = NOTICE_STEPS.map((s) => s.after);
  expect(after).toEqual([...after].sort((a, b) => a - b));
});

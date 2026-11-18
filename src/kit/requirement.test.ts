import { expect, test } from "bun:test";

import {
  atLeast,
  describeMissing,
  describeRequirement,
  named,
  none,
  peer,
  self,
  strictest,
} from "./requirement.ts";

test("strictest takes the highest level and everyone named", () => {
  expect(strictest()).toEqual({ level: "none", named: [] });
  expect(strictest(none, self)).toEqual({ level: "self", named: [] });
  expect(strictest(peer, self, none)).toEqual({ level: "peer", named: [] });
  expect(strictest(self, named("bob"), named("Bob", "carol"))).toEqual({
    level: "self",
    named: ["bob", "carol"],
  });
});

test("order does not matter", () => {
  const parts = [named("bob"), peer, self];
  expect(strictest(...parts)).toEqual(strictest(...parts.reverse()));
});

test("atLeast", () => {
  expect(atLeast(peer, self)).toBe(true);
  expect(atLeast(self, peer)).toBe(false);
  expect(atLeast(strictest(peer, named("bob")), named("BOB"))).toBe(true);
  expect(atLeast(peer, named("bob"))).toBe(false);
});

test("descriptions", () => {
  expect(describeRequirement(none)).toBe("no nod");
  expect(describeRequirement(peer)).toBe("a peer nod");
  expect(describeRequirement(strictest(peer, named("bob", "carol")))).toBe(
    "a peer nod, a nod from bob and a nod from carol",
  );
  expect(describeMissing([{ kind: "self", login: "alice" }])).toBe("a self nod");
  expect(describeMissing([{ kind: "peer" }, { kind: "named", login: "bob" }])).toBe(
    "a peer nod and a nod from bob",
  );
});

import { expect, test } from "bun:test";

import { ed25519PublicKeyBlob, publicKeyLine } from "../signer/ssh-wire";
import { enrolBody, enrolmentOf, principalsOf, setupStatusOf, signerLine } from "./setup";

const key = (fill: number) => publicKeyLine(ed25519PublicKeyBlob(new Uint8Array(32).fill(fill)));
const KEY = key(1);
const [TYPE, BLOB] = KEY.split(" ") as [string, string];

test("principals compare key blobs, not comments", () => {
  const text = `# who can nod\nalice namespaces="nod" ${TYPE} ${BLOB} laptop\nbob namespaces="nod" ${key(2)}\n`;
  expect(principalsOf(text, `${KEY} some-other-comment`)).toEqual(["alice"]);
  expect(principalsOf(text, key(3))).toEqual([]);
});

test("enrolment: active on the default branch, pending in an open PR, else not enrolled", () => {
  const line = signerLine("alice", KEY);
  expect(line).toBe(`alice namespaces="nod" ${TYPE} ${BLOB}`);
  const pr = { number: 9, url: "https://github.com/acme/widgets/pull/9" };
  expect(
    enrolmentOf({ publicKey: KEY, me: "Alice", signers: `${line}\n`, candidates: [] }),
  ).toEqual({
    state: "active",
  });
  expect(
    enrolmentOf({
      publicKey: KEY,
      me: "alice",
      signers: "",
      candidates: [{ pr, text: `${line}\n` }],
    }),
  ).toEqual({ state: "pending", pr });
  // the key under someone else's login is not mine
  expect(
    enrolmentOf({ publicKey: KEY, me: "alice", signers: signerLine("bob", KEY), candidates: [] }),
  ).toEqual({ state: "not-enrolled" });
  expect(enrolmentOf({ publicKey: KEY, me: null, signers: line, candidates: [] })).toEqual({
    state: "not-enrolled",
  });
});

test("the checklist: unknown before the first read, missing, pending in the setup PR, ready", () => {
  const base = {
    repo: "acme/widgets",
    defaultBranch: "main",
    requiresNod: null,
    autoMerge: null,
    setupPr: null,
  };
  expect(setupStatusOf({ ...base, files: null })).toMatchObject({ state: "missing" });
  expect(setupStatusOf({ ...base, files: null }).checks.every((c) => c.state === "unknown")).toBe(
    true,
  );
  const none = { policy: false, verifier: false, workflow: false, signers: false };
  expect(
    setupStatusOf({ ...base, files: none, requiresNod: false, autoMerge: false }),
  ).toMatchObject({
    state: "missing",
    checks: [
      { id: "policy", state: "missing", note: "missing" },
      { id: "verifier", state: "missing" },
      { id: "workflow", state: "missing" },
      { id: "allowed-signers", state: "missing" },
      {
        id: "required-check",
        state: "missing",
        note: "after merge",
        label: "Required check on main",
      },
      { id: "auto-merge", state: "missing", note: "after merge" },
    ],
  });
  const all = { policy: true, verifier: true, workflow: true, signers: true };
  const ready = setupStatusOf({
    ...base,
    files: all,
    requiresNod: false,
    autoMerge: true,
    setupPr: { number: 3, url: "u" },
  });
  expect(ready.state).toBe("ready");
  expect(ready.setupPr).toBeNull();
  expect(ready.checks.find((c) => c.id === "required-check")).toMatchObject({
    state: "missing",
    note: "run nod init --ruleset",
  });
});

test("the enrolment PR's brief names the fingerprint and why a teammate must nod", () => {
  const body = enrolBody("alice", KEY);
  expect(body).toMatch(/\*\*What\*\* .*`SHA256:[A-Za-z0-9+/]+`/);
  expect(body).toContain("**Risk:** high");
  expect(body).toContain("`.nod/**`");
  expect(body).toContain("**Look at**");
});

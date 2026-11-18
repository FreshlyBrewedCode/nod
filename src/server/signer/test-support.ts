/**
 * Test helpers for the signer: a key in memory, the same key as an
 * unencrypted OpenSSH private key file for `ssh-keygen` (temp dirs only,
 * never `~/.ssh`), and `ssh-keygen` runs without an agent. Not shipped code.
 */

import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { run, type RunResult } from "../../kit/exec.ts";
import { generateEd25519 } from "./ed25519";
import { ED25519, ed25519PublicKeyBlob, publicKeyLine, sshString, uint32 } from "./ssh-wire";

export const sshEnv = (): NodeJS.ProcessEnv => {
  const env = { ...process.env };
  delete env.SSH_AUTH_SOCK;
  return env;
};

export const sshKeygen = (args: string[], input?: string): Promise<RunResult> =>
  run("ssh-keygen", args, { env: sshEnv(), ...(input !== undefined && { input }) });

export function testKey(): { seed: Buffer; blob: Buffer; publicKey: string } {
  const { seed, publicKey } = generateEd25519();
  const blob = ed25519PublicKeyBlob(publicKey);
  return { seed, blob, publicKey: publicKeyLine(blob, "test") };
}

/**
 * `openssh-key-v1` without a cipher (OpenSSH's PROTOCOL.key), the format
 * `ssh-keygen` reads. Only for the byte-for-byte cross-check in a temp dir.
 */
export function opensshPrivateKey(seed: Buffer, publicKey: Buffer, comment = "test"): string {
  const check = uint32(0x6e6f6421);
  let secret = Buffer.concat([
    check,
    check,
    sshString(ED25519),
    sshString(publicKey),
    sshString(Buffer.concat([seed, publicKey])),
    sshString(comment),
  ]);
  const padding: number[] = [];
  for (let i = 1; (secret.length + padding.length) % 8 !== 0; i++) padding.push(i);
  secret = Buffer.concat([secret, Buffer.from(padding)]);
  const blob = Buffer.concat([
    Buffer.from("openssh-key-v1\0", "ascii"),
    sshString("none"),
    sshString("none"),
    sshString(""),
    uint32(1),
    sshString(ed25519PublicKeyBlob(publicKey)),
    sshString(secret),
  ]);
  const lines = blob.toString("base64").match(/.{1,70}/g)!;
  return `-----BEGIN OPENSSH PRIVATE KEY-----\n${lines.join("\n")}\n-----END OPENSSH PRIVATE KEY-----\n`;
}

/** Writes `seed` as an OpenSSH private key file (0600) in `dir`. */
export async function writeOpensshKey(
  dir: string,
  seed: Buffer,
  publicKey: Buffer,
): Promise<string> {
  const path = join(dir, "id_ed25519");
  await writeFile(path, opensshPrivateKey(seed, publicKey), { mode: 0o600 });
  return path;
}

/** `ssh-keygen -Y sign` over exactly `message`. */
export async function sshKeygenSign(
  dir: string,
  keyPath: string,
  message: string,
  namespace = "nod",
): Promise<string> {
  const file = join(dir, `msg-${Math.random().toString(36).slice(2)}`);
  await writeFile(file, message);
  const r = await sshKeygen(["-Y", "sign", "-q", "-f", keyPath, "-n", namespace, file]);
  if (r.status !== 0) throw new Error(r.stderr);
  return readFile(`${file}.sig`, "utf8");
}

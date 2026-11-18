/**
 * The ed25519 key in memory: generating one, and the `SigningMethod` that
 * signs with it while the key is unlocked. `node:crypto` does the curve
 * maths; ed25519 signatures are deterministic, so the same key and message
 * always give the same bytes.
 */

import { createPrivateKey, createPublicKey, generateKeyPairSync, sign } from "node:crypto";
import type { KeyObject } from "node:crypto";

import { ED25519, ed25519PublicKeyBlob, sshString } from "./ssh-wire";
import type { SigningMethod } from "./sshsig";

/** PKCS#8 wrapping of a raw 32-byte ed25519 seed (RFC 8410), for `createPrivateKey`. */
const PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");

/** A new key: the 32-byte seed (the secret) and the 32-byte public key. */
export function generateEd25519(): { seed: Buffer; publicKey: Buffer } {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  // DER rather than JWK: a Buffer can be zeroed, a base64 string cannot.
  const der = privateKey.export({ format: "der", type: "pkcs8" });
  if (der.length !== 48 || !der.subarray(0, 16).equals(PKCS8_PREFIX))
    throw new Error("unexpected ed25519 PKCS#8 encoding");
  const seed = Buffer.from(der.subarray(16));
  der.fill(0);
  return { seed, publicKey: rawPublicKey(publicKey) };
}

/** SPKI wrapping of a raw 32-byte ed25519 public key (RFC 8410). */
const SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

function rawPublicKey(key: KeyObject): Buffer {
  const der = key.export({ format: "der", type: "spki" });
  if (der.length !== 44 || !der.subarray(0, 12).equals(SPKI_PREFIX))
    throw new Error("unexpected ed25519 SPKI encoding");
  return Buffer.from(der.subarray(12));
}

function privateKeyFromSeed(seed: Uint8Array): KeyObject {
  if (seed.length !== 32) throw new Error("an ed25519 seed has 32 bytes");
  const der = Buffer.concat([PKCS8_PREFIX, seed]);
  try {
    return createPrivateKey({ key: der, format: "der", type: "pkcs8" });
  } finally {
    der.fill(0);
  }
}

/** The public key of a seed, 32 bytes. */
export function publicKeyOfSeed(seed: Uint8Array): Buffer {
  return rawPublicKey(createPublicKey(privateKeyFromSeed(seed)));
}

/**
 * Signs with the key in memory. The seed is copied into a `KeyObject` and
 * the caller's buffer is left alone (the caller zeroes it). `dispose` drops
 * the `KeyObject`; its native memory is freed when it is collected. JS gives
 * no way to wipe it sooner, so this is best effort, like every zeroing here.
 */
export function ed25519Method(seed: Uint8Array): SigningMethod {
  let key: KeyObject | null = privateKeyFromSeed(seed);
  const publicKeyBlob = ed25519PublicKeyBlob(publicKeyOfSeed(seed));
  return {
    publicKeyBlob,
    async signData(data) {
      if (!key) throw new Error("the key was disposed");
      return Buffer.concat([sshString(ED25519), sshString(sign(null, data, key))]);
    },
    dispose() {
      key = null;
    },
  };
}

# 0004: The signer: an encrypted key file, a session unlock, SSHSIG

Status: accepted (2026-11-18). Details the concept's "Signer" and "Known limits" lines (Trust model); it replaces nothing.

## Decision

1. **Key file.** `$XDG_CONFIG_HOME/nod/signing-key.json` (else `~/.config/nod/`), mode 0600, directory 0700 when nod creates it. One ed25519 key, made by `node:crypto`. The file is versioned JSON:

   ```json
   { "nod": "signing-key", "version": 1,
     "publicKey": "ssh-ed25519 AAAA… nod", "created": "2026-11-18T14:20:00.000Z",
     "kdf": { "name": "scrypt", "N": 131072, "r": 8, "p": 1, "salt": "<16 bytes, base64>" },
     "cipher": { "name": "aes-256-gcm", "nonce": "<12 bytes>", "ciphertext": "<32 bytes>", "tag": "<16 bytes>" } }
   ```

   - The plaintext is the 32-byte ed25519 seed. The plain key is never written anywhere.
   - The public key is in clear, so the app can show it and build the `allowed_signers` line (`<login> ssh-ed25519 AAAA…`) without a passphrase. The comment is `nod`: nothing about the person or the machine.
   - GCM's additional data is `nod-signing-key-v1\0` plus the public key blob, and after decrypting, the seed's own public key must equal the stored one. A file whose public half was swapped never signs.
   - A wrong passphrase and a tampered ciphertext, tag, nonce, salt or parameter look the same: the tag does not match (`bad-passphrase`). A file that does not parse, or names another version, is `bad-key-file`.
   - Written through a temp file in the same directory; never overwritten. `nod key create --replace` moves the old file to `signing-key.json.replaced-<time>`. The socket's `create-key` never replaces: a page that could drive the browser must not be able to throw the enrolled key away.

2. **KDF.** scrypt, N = 2^17, r = 8, p = 1, a 32-byte key. That is 128 MiB and about 0.2–0.3 s per try on the development machine (2^18: about 0.55 s and 256 MiB, for one more bit of work). The passphrase is NFC-normalised UTF-8. Parameters read from a file must stay within N ∈ [2^10, 2^20] (a power of two), r ≤ 16, p ≤ 4 and 1 GiB, so a planted file cannot exhaust memory; tests create keys with N = 2^10 through an injected option, never a flag or an environment variable.

3. **Passphrase.** Not empty, at least 12 characters (code points, `MIN_PASSPHRASE_LENGTH`), at most 1024. The key file is readable by every process of the user, agents included, so the passphrase is all that stands against an offline guess. Twelve characters rules out a word or a PIN and is still a short phrase to type. It is never logged, echoed or part of an error message.

4. **Unlock.** `unlock(passphrase, {minutes, once})` decrypts into a `KeyObject` in the server's memory for N minutes (15 by default, clamped to 1–60):
   - the window ends by the clock's time, even when its timer fires late (a suspended laptop);
   - `once` locks right after the next signature, and a second request racing it is refused;
   - `lock()` and stopping the server drop the key; buffers holding the seed, the derived key and the password bytes are zeroed, best effort (JS cannot wipe a string or the collector's copies);
   - a wrong passphrase fails after 1 s; unlocks run one at a time (each costs scrypt's memory);
   - the key file is read again on unlock: if its key is no longer the one the app shows, unlocking fails (`bad-key-file`, "restart nod serve").

5. **SSHSIG.** As OpenSSH's `PROTOCOL.sshsig`: the key signs `"SSHSIG" string("nod") string("") string("sha512") string(SHA-512(message))`; the outer blob is `"SSHSIG" uint32(1) string(public key) string("nod") string("") string("sha512") string(signature)`; armored as `ssh-keygen` writes it (base64 at 70 columns). The message is the payload line's bytes, no trailing newline (ADR 0001). The tests prove it byte for byte: for the same key and message, `ssh-keygen -Y sign` writes exactly our output, and every signature in the tests is checked by `ssh-keygen -Y verify`.

6. **Enrolment** compares key blobs (type and key, decoded), never strings with comments.

7. **Seam for other signing methods.** A `SigningMethod` only signs the inner blob: it has the public key blob and returns the SSH signature blob. The envelope (`signSshsig`) and the unlock window (`UnlockWindow`) are shared. An ssh-agent (Touch ID through the Secure Enclave, 1Password) fits it as is: `SSH_AGENTC_SIGN_REQUEST` takes the same key blob and data and returns the same signature blob.

8. **Not built: adopting an existing OpenSSH private key.** `ssh-keygen` would take the passphrase on its command line (`-P`), where other processes can read it; decrypting `openssh-key-v1` ourselves needs bcrypt_pbkdf, which `node:crypto` lacks. `create-key` with a `path` answers `not-implemented`; nod makes its own key.

## Known limits of passphrase mode

- While signing is unlocked, an agent running as the same user could drive the browser, or attach a debugger to the server process and read the key (this depends on the OS and its ptrace settings).
- Any process of the user can copy the key file and guess passphrases offline; scrypt makes each guess cost 128 MiB and a fraction of a second, which a weak passphrase does not survive.
- An agent could replace the key file with its own key. That key is not enrolled, and enrolling it is a PR to `.nod/**`, which a peer must nod (ADR 0002); a running server refuses the changed file.
- So passphrase mode guards against mistakes more than against a determined agent. Per-signature confirmation (Touch ID through an agent) closes the first gap. Admin tokens can still bypass rulesets.

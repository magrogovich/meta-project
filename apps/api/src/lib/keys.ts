// Persistent, revealable session keys: AES-256-GCM ciphertext + HMAC lookup tag.
// Master key from KEY_MASTER env (hex, base64 or raw string; hashed to 32 bytes).
// Ready to swap for a KMS: replace masterKey() with a KMS decrypt call.
import { createCipheriv, createDecipheriv, createHmac, createHash, randomBytes } from "crypto";

function masterKey(): Buffer {
  const raw = process.env.KEY_MASTER || "dev-master-key-change-me-in-production";
  if (/^[0-9a-fA-F]{64}$/.test(raw)) return Buffer.from(raw, "hex");
  try {
    const b = Buffer.from(raw, "base64");
    if (b.length === 32 && raw.length >= 40) return b;
  } catch { /* not base64 */ }
  return createHash("sha256").update(raw).digest();
}

export function newSessionKey(): string {
  return "ak_" + randomBytes(32).toString("hex");
}

export function encryptKey(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", masterKey(), iv);
  const ct = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return `${iv.toString("base64")}.${ct.toString("base64")}.${cipher.getAuthTag().toString("base64")}`;
}

export function decryptKey(enc: string): string {
  const [iv, ct, tag] = enc.split(".");
  if (!iv || !ct || !tag) throw new Error("bad key envelope");
  const decipher = createDecipheriv("aes-256-gcm", masterKey(), Buffer.from(iv, "base64"));
  decipher.setAuthTag(Buffer.from(tag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(ct, "base64")), decipher.final()]).toString("utf8");
}

// Deterministic lookup tag: HMAC(master, key). Stored alongside ciphertext so the
// agent can authenticate WITHOUT decrypting every row (and without a decrypt oracle).
export function keyTag(key: string): string {
  return createHmac("sha256", masterKey()).update("arocall-session-key:" + key).digest("hex");
}

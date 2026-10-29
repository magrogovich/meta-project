import test from "node:test";
import assert from "node:assert";
import { newSessionKey, encryptKey, decryptKey, keyTag } from "./lib/keys.js";
import { ensureSchema } from "./db/migrate.js";
import { db, pool } from "./db/client.js";
import * as s from "./db/schema.js";
import { eq } from "drizzle-orm";

test("key encrypt/decrypt roundtrip", () => {
  const k = newSessionKey();
  assert.equal(decryptKey(encryptKey(k)), k);
});

test("tampered ciphertext fails auth", () => {
  const enc = encryptKey(newSessionKey());
  const [iv, ct, tag] = enc.split(".");
  assert.throws(() => decryptKey(`${iv}.${Buffer.from("tampered").toString("base64")}.${tag}`));
});

test("keyTag is deterministic and unique", () => {
  const a = newSessionKey(), b = newSessionKey();
  assert.equal(keyTag(a), keyTag(a));
  assert.notEqual(keyTag(a), keyTag(b));
});

test("agent authentication survives key regeneration (old key stops working)", async () => {
  await ensureSchema();
  const [org] = await db.insert(s.orgs).values({ name: "key-test-org" }).returning();
  const oldKey = newSessionKey();
  const [e] = await db.insert(s.employees).values({
    orgId: org.id, name: "Key Test", department: "Support", languages: ["en"],
    sessionKeyEnc: encryptKey(oldKey), sessionKeyHmac: keyTag(oldKey), sessionKeyRevoked: false,
  }).returning();
  const lookup = async (k: string) =>
    (await db.select().from(s.employees).where(eq(s.employees.sessionKeyHmac, keyTag(k))))[0];
  assert.ok(await lookup(oldKey), "old key authenticates");
  // regenerate
  const fresh = newSessionKey();
  await db.update(s.employees).set({ sessionKeyEnc: encryptKey(fresh), sessionKeyHmac: keyTag(fresh) }).where(eq(s.employees.id, e.id));
  assert.ok(!(await lookup(oldKey)), "old key rejected after regeneration");
  assert.ok(await lookup(fresh), "new key authenticates");
  // revoke
  await db.update(s.employees).set({ sessionKeyRevoked: true }).where(eq(s.employees.id, e.id));
  const revoked = await lookup(fresh);
  assert.ok(revoked?.sessionKeyRevoked, "revoked flag visible to auth layer");
  // cleanup
  await db.delete(s.employees).where(eq(s.employees.id, e.id));
  await db.delete(s.users).where(eq(s.users.orgId, org.id));
  await db.delete(s.orgs).where(eq(s.orgs.id, org.id));
  await pool.end();
});

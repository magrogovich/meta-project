import "dotenv/config";
import { eq } from "drizzle-orm";
import { db, pool } from "./db/client.js";
import * as s from "./db/schema.js";
import { DEFAULT_CRITERIA } from "./lib/muse.js";
import { sha256, newSessionKey, saveAudio, synthWav } from "./lib/util.js";
import { processCall } from "./routes/calls.js";
import { ensureSchema } from "./db/migrate.js";
import bcrypt from "bcryptjs";

await ensureSchema();

const FIRST = ["Amara", "Jonas", "Sofia", "Liam", "Priya"];
const LAST = ["Diallo", "Weber", "Marsh", "Okafor", "Nair"];
const DEPTS = ["Support", "Billing", "Retention", "Sales"];
const LANGS = ["en", "fr", "de", "es"];

const AGENT_GOOD = [
  "Hello, thank you for calling Arocall, my name is {n}, how can I help you today?",
  "I understand how frustrating this is, I hear you, and I am sorry for the trouble.",
  "Let me verify your account and confirm the details so we follow policy.",
  "I will fix this by tomorrow and send a confirmation email with the next steps.",
  "To summarize, we resolved the billing error. Is there anything else? Thank you so much, goodbye!",
];
const AGENT_BAD = [
  "Yeah, what do you want?",
  "That is not my problem, calm down.",
  "I guarantee you will get triple refund, no need to verify anything.",
  "I do not know, maybe call back later.",
  "Bye.",
];
const CUST = ["Hi, my bill looks wrong this month.", "I have been waiting for a week!", "Can you just fix it please?", "What are the next steps?", "Okay, thanks for your help."];

function transcript(quality: number, lang: string, name: string) {
  const good = quality > 0.55;
  const lines: any[] = [];
  let t = 0;
  const poolLines = good ? AGENT_GOOD : AGENT_BAD;
  const greet = lang === "fr" ? "Bonjour, merci d'avoir appelé Arocall" : lang === "de" ? "Guten Tag, danke für Ihren Anruf bei Arocall" : lang === "es" ? "Hola, gracias por llamar a Arocall" : poolLines[0].replace("{n}", name);
  lines.push({ speaker: "Agent", text: greet, start: t, end: t + 4 }); t += 5;
  for (let i = 0; i < 4; i++) {
    lines.push({ speaker: "Customer", text: CUST[i % CUST.length], start: t, end: t + 3 }); t += 4;
    lines.push({ speaker: "Agent", text: poolLines[(i + 1) % poolLines.length].replace("{n}", name), start: t, end: t + 4 }); t += 5;
  }
  return { lines, dur: t };
}

const email = process.env.SEED_EMAIL || "demo@arocall.ai";
const pass = process.env.SEED_PASS || "demo1234";
let users = await db.select().from(s.users).where(eq(s.users.email, email));
let orgId: string;
if (!users.length) {
  const [org] = await db.insert(s.orgs).values({ name: "Arocall Demo" }).returning();
  orgId = org.id;
  const hash = await bcrypt.hash(pass, 10);
  await db.insert(s.users).values({ orgId, email, name: "Demo Admin", passwordHash: hash, role: "admin" });
  await db.insert(s.scorecards).values({ orgId, version: 1, criteria: DEFAULT_CRITERIA, sourceText: "Demo QA policy" });
  console.log(`created login ${email} / ${pass}`);
} else { orgId = users[0].orgId; console.log(`using login ${email} / ${pass}`); }

const existing = await db.select().from(s.employees).where(eq(s.employees.orgId, orgId));
// FK order: coaching sessions -> memos -> criterion results -> calls -> employees
await db.delete(s.coachingSessions).where(eq(s.coachingSessions.orgId, orgId));
await db.delete(s.memos).where(eq(s.memos.orgId, orgId));
for (const e of existing) {
  const cs = await db.select().from(s.calls).where(eq(s.calls.employeeId, e.id));
  for (const c of cs) await db.delete(s.criterionResults).where(eq(s.criterionResults.callId, c.id));
  await db.delete(s.calls).where(eq(s.calls.employeeId, e.id));
  await db.delete(s.employees).where(eq(s.employees.id, e.id));
}

// 5 employees: improver (idx0: 45->92), decliner (idx1: 90->48), others mid
for (let i = 0; i < 5; i++) {
  const name = `${FIRST[i]} ${LAST[i]}`;
  const key = newSessionKey();
  const [e] = await db.insert(s.employees).values({ orgId, name, department: DEPTS[i % 4], languages: [LANGS[i % 4], "en"], startDate: "2025-01-15", sessionKeyHash: sha256(key), sessionKeyPrefix: key.slice(0, 8) }).returning();
  console.log(`employee ${name} key=${key}`);
  for (let k = 0; k < 8; k++) {
    let q: number;
    if (i === 0) q = 0.35 + (k / 7) * 0.6;       // improves
    else if (i === 1) q = 0.9 - (k / 7) * 0.55;  // declines
    else q = 0.55 + 0.2 * Math.sin(k + i);
    const lang = (e.languages as string[])[k % 2];
    const { lines, dur } = transcript(q, lang, FIRST[i]);
    const file = saveAudio(synthWav(dur, i + 2), `seed_${i}_${k}.wav`);
    const started = new Date(Date.now() - (8 - k) * 3 * 864e5 - i * 36e5);
    const [c] = await db.insert(s.calls).values({ orgId, employeeId: e.id, language: lang, audioFile: file, status: "uploaded", transcript: lines, durationSec: dur, startedAt: started }).returning();
    await processCall(c.id);
  }
}
console.log("seed done: 5 employees x 8 calls = 40");
await pool.end();

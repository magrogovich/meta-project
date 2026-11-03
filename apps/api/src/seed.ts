import "./lib/env.js";
import { eq, and } from "drizzle-orm";
import { db, pool } from "./db/client.js";
import * as s from "./db/schema.js";
import { generateCriteria } from "./lib/muse.js";
import { newSessionKey, encryptKey, keyTag } from "./lib/keys.js";
import { saveAudio, synthWav } from "./lib/util.js";
import { processCall } from "./routes/calls.js";
import { ensureSchema } from "./db/migrate.js";
import bcrypt from "bcryptjs";

await ensureSchema();

type Persona = "improver" | "decliner" | "strong" | "weak-empathy" | "average";
const PEOPLE: { first: string; last: string; dept: string; langs: string[]; persona: Persona }[] = [
  { first: "Amara", last: "Diallo", dept: "Support", langs: ["en", "fr"], persona: "improver" },
  { first: "Jonas", last: "Weber", dept: "Support", langs: ["en", "de"], persona: "decliner" },
  { first: "Sofia", last: "Marsh", dept: "Billing", langs: ["en", "es"], persona: "strong" },
  { first: "Liam", last: "Okafor", dept: "Billing", langs: ["en", "fr"], persona: "weak-empathy" },
  { first: "Priya", last: "Nair", dept: "Support", langs: ["en", "es"], persona: "average" },
];

const CUST_OPEN = [
  "Hi, my bill looks wrong this month, I'm really frustrated.",
  "Hello, I've been waiting a week and I'm furious about this charge.",
  "Hi, I need help with my account, it's quite urgent.",
];
const CUST_MID = ["Can you just fix it please?", "What are the next steps?", "I need this sorted today."];
const CUST_HAPPY = ["Thanks, that's perfect, I appreciate it!", "Great, thank you so much for resolving this!"];
const CUST_ANGRY = [
  "This is terrible, get me your supervisor right now!",
  "No, that's not good enough. I want to speak to your manager!",
];
const CUST_FLAT = ["Okay, I see.", "Alright, noted."];

function agentLines(good: boolean, weakEmpathy: boolean, complianceFail: boolean, name: string, lang: string) {
  const greetOk = lang === "fr" ? "Bonjour, merci d'avoir appelé Arocall, je m'appelle " + name
    : lang === "de" ? "Guten Tag, danke für Ihren Anruf bei Arocall, mein Name ist " + name
    : lang === "es" ? "Hola, gracias por llamar a Arocall, me llamo " + name
    : `Hello, thank you for calling Arocall, my name is ${name}, how can I help you today?`;
  const greet = good || Math.random() > 0.2 ? greetOk : "Yeah, what do you want?";
  const empathy = weakEmpathy || !good
    ? ["That is not my problem, calm down.", "Whatever, let's move on."][Math.floor(Math.random() * 2)]
    : "I understand how frustrating this is, I hear you, and I am sorry for the trouble.";
  const compliance = complianceFail
    ? "I guarantee you will get a triple refund, no need to verify anything."
    : "Let me verify your account and confirm the details so we follow policy.";
  const resolution = good
    ? "I will fix this by tomorrow and send a confirmation email with the next steps."
    : "I don't know, maybe call back later.";
  const close = good
    ? "To summarize, we resolved the billing error. Is there anything else? Thank you so much, goodbye!"
    : "Bye.";
  return [greet, empathy, compliance, resolution, close];
}

// quality 0..1 controls good vs bad + sentiment trajectory
function buildTranscript(opts: { quality: number; lang: string; name: string; weakEmpathy: boolean; complianceFail: boolean; supervisor: boolean; dayIdx: number }) {
  const { quality, lang, name, weakEmpathy, complianceFail, supervisor, dayIdx } = opts;
  const good = quality > 0.5;
  const [g, em, co, re, cl] = agentLines(good, weakEmpathy, complianceFail, name, lang);
  const lines: any[] = [];
  let t = 0;
  const push = (speaker: string, text: string, dur: number, gap = 1) => {
    lines.push({ speaker, text, start: Math.round(t * 10) / 10, end: Math.round((t + dur) * 10) / 10 });
    t += dur + gap;
  };
  push("Agent", g, 4);
  push("Customer", CUST_OPEN[dayIdx % CUST_OPEN.length], 3);
  push("Agent", em, 4, weakEmpathy ? 0.2 : 1); // weak-empathy agents interrupt (short gap)
  push("Customer", CUST_MID[dayIdx % CUST_MID.length], 3, good ? 2.5 : 1); // dead-air gap on good calls
  push("Agent", co, 4);
  push("Customer", supervisor ? CUST_ANGRY[dayIdx % CUST_ANGRY.length] : CUST_MID[(dayIdx + 1) % CUST_MID.length], 3);
  // interruption: agent overlaps customer on bad calls
  if (!good && dayIdx % 3 === 0) {
    const overlapStart = Math.round((t - 1.2) * 10) / 10;
    lines.push({ speaker: "Agent", text: re, start: overlapStart, end: overlapStart + 4 });
    t += 4 + 1;
  } else {
    push("Agent", re, 4);
  }
  const endText = supervisor ? CUST_ANGRY[(dayIdx + 1) % CUST_ANGRY.length]
    : good ? CUST_HAPPY[dayIdx % CUST_HAPPY.length]
    : quality < 0.35 ? CUST_ANGRY[dayIdx % CUST_ANGRY.length] : CUST_FLAT[dayIdx % CUST_FLAT.length];
  push("Customer", endText, 3);
  push("Agent", cl, 4, 3); // trailing silence -> dead air
  const dur = Math.round(t);
  return { lines, dur };
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
  console.log(`created login ${email} / ${pass}`);
} else { orgId = users[0].orgId; console.log(`using login ${email} / ${pass}`); }

// quality targets
await db.update(s.orgs).set({
  settings: {
    quality: { qaTarget: 80, passThreshold: 70, scoreBelow: 70, dropPoints: 10, criticalCount: 2 },
    coaching: { qaTarget: 80, passThreshold: 70, scoreBelow: 70, dropPoints: 10, criticalCount: 2 },
  },
}).where(eq(s.orgs.id, orgId));

// guidelines + approved criteria
{
  const { readFileSync, existsSync } = await import("fs");
  const { join, dirname } = await import("path");
  const { fileURLToPath } = await import("url");
  const { hashContent, splitSections } = await import("./lib/guidelines.js");
  const here = dirname(fileURLToPath(import.meta.url));
  const samplePath = join(here, "..", "seed", "guidelines-sample.md");
  const md = existsSync(samplePath) ? readFileSync(samplePath, "utf8") : "# Guidelines\n\n## Greeting\n\nGreet every caller.\n";
  const prior = await db.select().from(s.guidelines).where(eq(s.guidelines.orgId, orgId));
  if (!prior.length) {
    const [d] = await db.insert(s.guidelines).values({ orgId, title: "Call Handling Guidelines", status: "active", currentVersion: 1, createdBy: "seed" }).returning();
    const sections = splitSections(md).map(({ id, path, level, title }) => ({ id, path, level, title }));
    await db.insert(s.guidelineVersions).values({ guidelineId: d.id, version: 1, markdown: md, contentHash: hashContent(md), sections, createdBy: "seed" });
    const { criteria } = await generateCriteria([{ guidelineId: d.id, version: 1, markdown: md }]);
    if (criteria.length) {
      await db.insert(s.criteriaSets).values({ orgId, version: 1, status: "approved", criteria, guidelineRefs: { [d.id]: 1 }, stale: false });
      console.log(`seeded guidelines + approved criteria v1 (${criteria.length} criteria)`);
    }
  }
}

const existing = await db.select().from(s.employees).where(eq(s.employees.orgId, orgId));
await db.delete(s.coachingSessions).where(eq(s.coachingSessions.orgId, orgId));
await db.delete(s.memos).where(eq(s.memos.orgId, orgId));
await db.delete(s.actionItems).where(eq(s.actionItems.orgId, orgId));
await db.delete(s.auditLog).where(eq(s.auditLog.orgId, orgId));
for (const e of existing) {
  const cs = await db.select().from(s.calls).where(eq(s.calls.employeeId, e.id));
  for (const c of cs) await db.delete(s.criterionResults).where(eq(s.criterionResults.callId, c.id));
  await db.delete(s.calls).where(eq(s.calls.employeeId, e.id));
  await db.delete(s.employees).where(eq(s.employees.id, e.id));
}

for (const d of ["Support", "Billing"]) {
  const rows = await db.select().from(s.departments).where(and(eq(s.departments.orgId, orgId), eq(s.departments.name, d)));
  if (!rows.length) await db.insert(s.departments).values({ orgId, name: d });
}

const CALLS_PER = 12;
let complianceFails = 0, supervisorCount = 0;
const empRows: any[] = [];
for (let i = 0; i < PEOPLE.length; i++) {
  const p = PEOPLE[i];
  const name = `${p.first} ${p.last}`;
  const key = newSessionKey();
  const [e] = await db.insert(s.employees).values({
    orgId, name, email: `${p.first.toLowerCase()}.${p.last.toLowerCase()}@example.com`,
    department: p.dept, languages: p.langs, startDate: "2025-01-15",
    sessionKeyHash: "", sessionKeyPrefix: key.slice(0, 8),
    sessionKeyEnc: encryptKey(key), sessionKeyHmac: keyTag(key),
    sessionKeyRevoked: false, status: "active",
  }).returning();
  empRows.push(e);
  console.log(`employee ${name} [${p.persona}] key=${key}`);
  for (let k = 0; k < CALLS_PER; k++) {
    // spread over last 60 days: k=0 oldest (59d ago), k=11 newest (1d ago)
    const daysAgo = 59 - Math.round((k / (CALLS_PER - 1)) * 58);
    let q: number;
    const prog = k / (CALLS_PER - 1);
    if (p.persona === "improver") q = 0.3 + prog * 0.65;
    else if (p.persona === "decliner") q = 0.92 - prog * 0.6;
    else if (p.persona === "strong") q = 0.78 + 0.12 * Math.sin(k * 1.3);
    else if (p.persona === "weak-empathy") q = 0.62 + 0.08 * Math.sin(k + 1);
    else q = 0.6 + 0.15 * Math.sin(k * 0.9 + 2);
    q = Math.min(0.95, Math.max(0.15, q));
    // force at least 3 compliance failures total: decliner k=8, weak-empathy k=9, average k=7
    const forceCompliance = (i === 1 && k === 8) || (i === 3 && k === 9) || (i === 4 && k === 7);
    const complianceFail = forceCompliance || (q < 0.3 && k % 4 === 0);
    if (complianceFail) complianceFails++;
    const supervisor = forceCompliance || (i === 0 && k === 0) || (i === 1 && (k === 9 || k === 10)) || (i === 4 && k === 8) ||
      (!forceCompliance && q < 0.35 && k % 3 === 1 && supervisorCount < 4);
    if (supervisor) supervisorCount++;
    const lang = p.langs[k % p.langs.length];
    const { lines, dur } = buildTranscript({
      quality: q, lang, name: p.first,
      weakEmpathy: p.persona === "weak-empathy",
      complianceFail, supervisor, dayIdx: k,
    });
    const file = saveAudio(synthWav(dur, i + 2), `seed_${i}_${k}.wav`);
    const started = new Date(Date.now() - daysAgo * 864e5 - (k % 5) * 36e5);
    const [c] = await db.insert(s.calls).values({
      orgId, employeeId: e.id, language: lang, audioFile: file,
      status: "uploaded", transcript: lines, durationSec: dur, startedAt: started,
    }).returning();
    await processCall(c.id);
  }
}
// 2 failed-processing calls (extra, recent)
for (let j = 0; j < 2; j++) {
  const e = empRows[j % empRows.length];
  const file = saveAudio(synthWav(30, 9), `seed_failed_${j}.wav`);
  await db.insert(s.calls).values({
    orgId, employeeId: e.id, language: "en", audioFile: file,
    status: "failed", transcript: [], durationSec: 30, startedAt: new Date(Date.now() - (2 + j) * 864e5),
  });
}
// agent presence: Amara online now, Jonas offline (stale), rest never/online mix
await db.update(s.employees).set({ lastSeen: new Date(), agentStatus: "online", agentVersion: "1.4.0" }).where(eq(s.employees.id, empRows[0].id));
await db.update(s.employees).set({ lastSeen: new Date(Date.now() - 6 * 36e5), agentStatus: "offline", agentVersion: "1.4.0" }).where(eq(s.employees.id, empRows[1].id));
await db.update(s.employees).set({ lastSeen: new Date(), agentStatus: "online", agentVersion: "1.4.0" }).where(eq(s.employees.id, empRows[2].id));
// human-flagged coaching session for the decliner
await db.insert(s.coachingSessions).values({
  orgId, employeeId: empRows[1].id, topics: "Compliance drift + empathy",
  transcript: [{ role: "employee", text: "I feel the targets are unfair.", at: new Date().toISOString() }],
  summary: "Employee raised fairness concerns.", actionItems: ["Review verification script"],
  humanFlag: true, token: "cs_seedflag1", transport: "meet", status: "ended",
});
console.log(`seed done: 5 employees x ${CALLS_PER} calls = ${5 * CALLS_PER} + 2 failed; complianceFails=${complianceFails}, supervisor=${supervisorCount}`);
for (let i = 0; i < empRows.length; i++) {
  await db.insert(s.actionItems).values([
    { orgId, employeeId: empRows[i].id, text: "Use the empathy opener on every call", status: i % 2 ? "done" : "open", source: "coach" },
    { orgId, employeeId: empRows[i].id, text: "Apply the 3-step close", status: i % 3 === 0 ? "done" : "open", source: "memo" },
  ]);
}
await pool.end();

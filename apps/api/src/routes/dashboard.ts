import { Router } from "express";
import { eq } from "drizzle-orm";
import { db } from "../db/client.js";
import * as s from "../db/schema.js";
import { authMw } from "./auth.js";

export const dashRouter = Router();
dashRouter.use(authMw);

type Range = { from: Date; to: Date; prevFrom: Date; prevTo: Date };

function resolveRange(from?: string, to?: string): Range {
  const now = new Date();
  const toD = to ? new Date(to + (to.length <= 10 ? "T23:59:59.999Z" : "")) : now;
  const fromD = from ? new Date(from + (from.length <= 10 ? "T00:00:00.000Z" : "")) : new Date(toD.getTime() - 30 * 864e5);
  const len = Math.max(864e5, toD.getTime() - fromD.getTime());
  return { from: fromD, to: toD, prevFrom: new Date(fromD.getTime() - len), prevTo: fromD };
}

const cache = new Map<string, { at: number; body: any }>();
const TTL = 60_000;

const DEFS: Record<string, string> = {
  qaScore: "Average score of analyzed calls in the period.",
  passRate: "% of analyzed calls with score >= pass threshold.",
  criticalRate: "% of analyzed calls where ANY must-pass criterion failed.",
  sentiment: "% of analyzed calls with end sentiment neutral or positive. AI estimate.",
  resolution: "% of analyzed calls with issue resolved=yes (excludes unclear). AI estimate.",
  coverage: "Analyzed calls ÷ calls recorded (uploaded) in the period. Typical manual QA reviews 1–2% of calls.",
};

const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const r1 = (n: number | null) => (n == null ? null : Math.round(n * 10) / 10);
const delta = (a: number | null, b: number | null) => (a == null || b == null ? null : Math.round((a - b) * 10) / 10);

dashRouter.get("/summary", async (req: any, res) => {
  const { from, to, dept, lang } = req.query as any;
  const orgId = req.user.orgId;
  const key = `${orgId}|${from || ""}|${to || ""}|${dept || ""}|${lang || ""}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL) return res.json(hit.body);

  const range = resolveRange(from, to);
  const { getRules } = await import("./coaching.js");
  const rules = await getRules(orgId);
  const { mustPassIds } = await import("../lib/context.js");
  const mustIds = await mustPassIds(orgId);

  let emps = await db.select().from(s.employees).where(eq(s.employees.orgId, orgId));
  if (dept) emps = emps.filter((e) => e.department === dept);
  const empIds = new Set(emps.map((e) => e.id));
  const empById: Record<string, any> = {};
  for (const e of emps) empById[e.id] = e;

  const allCalls = (await db.select().from(s.calls).where(eq(s.calls.orgId, orgId))).filter((c) => empIds.has(c.employeeId));
  const inR = (c: any, a: Date, b: Date) => { const t = +new Date(c.startedAt || 0); return t >= +a && t <= +b; };
  const cur = allCalls.filter((c) => inR(c, range.from, range.to) && (!lang || c.language === lang));
  const prev = allCalls.filter((c) => inR(c, range.prevFrom, range.prevTo) && (!lang || c.language === lang));
  const doneCur = cur.filter((c) => c.status === "done");
  const donePrev = prev.filter((c) => c.status === "done");

  const callIds = new Set([...cur, ...prev].map((c) => c.id));
  const critAll = (await db.select().from(s.criterionResults)).filter((r) => callIds.has(r.callId));
  const byCall: Record<string, typeof critAll> = {};
  for (const r of critAll) (byCall[r.callId] = byCall[r.callId] || []).push(r);
  const isCrit = (cid: string) => (byCall[cid] || []).some((r) => r.result === "fail" && mustIds.has(r.criterionId));

  const kpiOf = (rows: typeof doneCur) => {
    const qa = r1(avg(rows.map((c) => c.score)));
    const pass = rows.length ? r1((rows.filter((c) => c.score >= rules.passThreshold).length / rows.length) * 100) : null;
    const critN = rows.filter((c) => isCrit(c.id));
    const critRate = rows.length ? r1((critN.length / rows.length) * 100) : null;
    const withSent = rows.filter((c) => (c as any).sentimentEnd);
    const sent = withSent.length ? r1((withSent.filter((c) => ["neutral", "positive"].includes((c as any).sentimentEnd)).length / withSent.length) * 100) : null;
    const withRes = rows.filter((c) => (c as any).issueResolved && (c as any).issueResolved !== "unclear");
    const allKnown = rows.filter((c) => (c as any).issueResolved && (c as any).issueResolved !== "");
    const resRate = allKnown.length ? r1((rows.filter((c) => (c as any).issueResolved === "yes").length / Math.max(1, rows.filter((c) => (c as any).issueResolved === "yes" || (c as any).issueResolved === "no").length)) * 100) : null;
    void withRes;
    return { qa, pass, critRate, critN: critN.length, sent, resRate };
  };
  const kCur = kpiOf(doneCur), kPrev = kpiOf(donePrev);
  const covCur = cur.length ? r1((doneCur.length / cur.length) * 100) : null;
  const covPrev = prev.length ? r1((donePrev.length / prev.length) * 100) : null;

  const spark = (rows: typeof doneCur, fn: (c: any) => number | null) => {
    const byDay: Record<string, number[]> = {};
    for (const c of rows) { const d = new Date(c.startedAt || 0).toISOString().slice(0, 10); (byDay[d] = byDay[d] || []).push(fn(c) ?? NaN); }
    return Object.entries(byDay).sort().map(([t, vs]) => ({ t, v: r1(avg(vs.filter((v) => !isNaN(v)))) }));
  };

  const kpis = {
    qa: { value: kCur.qa, delta: delta(kCur.qa, kPrev.qa), spark: spark(doneCur, (c) => c.score), calls: doneCur.length },
    pass: { value: kCur.pass, delta: delta(kCur.pass, kPrev.pass), aht: r1(avg(doneCur.map((c) => c.durationSec))) },
    critical: { value: kCur.critRate, count: kCur.critN, delta: delta(kCur.critRate, kPrev.critRate) },
    sentiment: { value: kCur.sent, delta: delta(kCur.sent, kPrev.sent) },
    resolution: { value: kCur.resRate, delta: delta(kCur.resRate, kPrev.resRate) },
    coverage: { value: covCur, delta: delta(covCur, covPrev), analyzed: doneCur.length, recorded: cur.length },
  };

  // ---- attention (ranked) ----
  type Item = { severity: "critical" | "warning" | "info"; kind: string; text: string; link: string; rank: number };
  const items: Item[] = [];
  for (const c of doneCur.filter((c) => isCrit(c.id))) {
    const fails = (byCall[c.id] || []).filter((r) => r.result === "fail" && mustIds.has(r.criterionId)).map((r) => r.criterionName).join(", ");
    items.push({ severity: "critical", kind: "critical", text: `Critical: ${empById[c.employeeId]?.name || "Agent"} failed must-pass (${fails}) — ${c.score} pts`, link: `/calls/${c.id}`, rank: 0 });
  }
  const perEmpAvg = (id: string, rows: typeof doneCur) => {
    const m = rows.filter((c) => c.employeeId === id).map((c) => c.score);
    return m.length ? m.reduce((a, b) => a + b, 0) / m.length : null;
  };
  for (const e of emps) {
    const a = perEmpAvg(e.id, doneCur), b = perEmpAvg(e.id, donePrev);
    if (a != null && b != null && a - b <= -rules.dropPoints)
      items.push({ severity: "warning", kind: "drop", text: `${e.name} dropped ${r1(a - b)} pts (${r1(b)} → ${r1(a)})`, link: `/employees/${e.id}`, rank: 1 });
  }
  // repeated same-criterion fails in a row
  for (const e of emps) {
    const mine = doneCur.filter((c) => c.employeeId === e.id).sort((a, b) => +new Date(a.startedAt || 0) - +new Date(b.startedAt || 0));
    const last = mine.slice(-rules.criticalCount);
    if (last.length >= rules.criticalCount) {
      const failsByCrit: Record<string, number> = {};
      for (const c of last) for (const r of byCall[c.id] || []) if (r.result === "fail") failsByCrit[r.criterionName] = (failsByCrit[r.criterionName] || 0) + 1;
      for (const [name, n] of Object.entries(failsByCrit))
        if (n >= rules.criticalCount) items.push({ severity: "warning", kind: "repeat", text: `${e.name} failed ${name} ${n}× in a row`, link: `/calls?employeeId=${e.id}`, rank: 2 });
    }
  }
  for (const c of doneCur.filter((c) => (c as any).supervisorRequested))
    items.push({ severity: "warning", kind: "supervisor", text: `Customer asked for a supervisor — ${empById[c.employeeId]?.name || ""}`, link: `/calls/${c.id}`, rank: 3 });
  const sessions = await db.select().from(s.coachingSessions).where(eq(s.coachingSessions.orgId, orgId));
  for (const x of sessions.filter((x) => x.humanFlag))
    items.push({ severity: "warning", kind: "flag", text: `Human evaluator requested (${empById[(x as any).employeeId]?.name || "session"})`, link: `/coaching`, rank: 4 });
  const offline = emps.filter((e) => e.agentStatus !== "never" && !(e.lastSeen && Date.now() - +new Date(e.lastSeen) < 15 * 60e3));
  for (const e of offline) items.push({ severity: "info", kind: "offline", text: `${e.name}'s desktop agent offline`, link: `/employees/${e.id}`, rank: 5 });
  for (const c of cur.filter((c) => c.status === "failed"))
    items.push({ severity: "info", kind: "failed", text: `Processing failed (${c.language}, ${new Date(c.startedAt || 0).toLocaleDateString()})`, link: `/calls/${c.id}`, rank: 6 });
  const sevOrder = { critical: 0, warning: 1, info: 2 };
  items.sort((a, b) => sevOrder[a.severity] - sevOrder[b.severity] || a.rank - b.rank);
  const attention = items.slice(0, 8);

  // ---- trend (daily, weekly if range > 60d) ----
  const days = Math.max(1, Math.round((+range.to - +range.from) / 864e5));
  const weekly = days > 60;
  const bucketKey = (d: Date) => {
    if (!weekly) return d.toISOString().slice(0, 10);
    const t = new Date(d); const day = (t.getUTCDay() + 6) % 7; t.setUTCDate(t.getUTCDate() - day);
    return t.toISOString().slice(0, 10);
  };
  const buckets: Record<string, number[]> = {};
  for (const c of doneCur) { const k = bucketKey(new Date(c.startedAt || 0)); (buckets[k] = buckets[k] || []).push(c.score); }
  const trend = Object.entries(buckets).sort().map(([t, vs]) => ({ t, score: r1(avg(vs)), count: vs.length }));

  // ---- criteria performance ----
  const critCur = critAll.filter((r) => doneCur.some((c) => c.id === r.callId));
  const critPrev = critAll.filter((r) => donePrev.some((c) => c.id === r.callId));
  const agg = (rows: typeof critCur) => {
    const m: Record<string, { id: string; name: string; pass: number; total: number }> = {};
    for (const r of rows) { const k = (m[r.criterionId] = m[r.criterionId] || { id: r.criterionId, name: r.criterionName, pass: 0, total: 0 }); k.total++; if (r.result === "pass") k.pass++; }
    return m;
  };
  const aC = agg(critCur), aP = agg(critPrev);
  const criteria = Object.values(aC).map((v) => ({
    ...v, rate: v.total ? r1((v.pass / v.total) * 100) : null,
    delta: v.total && aP[v.id]?.total ? delta(r1((v.pass / v.total) * 100), r1((aP[v.id].pass / aP[v.id].total) * 100)) : null,
  })).sort((a, b) => (a.rate ?? 999) - (b.rate ?? 999));

  // ---- heatmap ----
  const heatmap = emps.map((e) => {
    const cells: Record<string, { rate: number | null; n: number; low: boolean }> = {};
    for (const c of Object.values(aC)) {
      const rs = critCur.filter((r) => r.criterionId === (c as any).id && doneCur.some((x) => x.id === r.callId && x.employeeId === e.id));
      const n = rs.length, rate = n ? r1((rs.filter((r) => r.result === "pass").length / n) * 100) : null;
      cells[(c as any).id] = { rate, n, low: n < 3 };
    }
    const sc = perEmpAvg(e.id, doneCur), scP = perEmpAvg(e.id, donePrev);
    return { id: e.id, name: e.name, cells, score: r1(sc), delta: sc != null && scP != null ? r1(sc - scP) : null, calls: doneCur.filter((c) => c.employeeId === e.id).length };
  }).sort((a, b) => (a.score ?? 999) - (b.score ?? 999));

  // ---- agents table ----
  const memos = await db.select().from(s.memos).where(eq(s.memos.orgId, orgId));
  const lastCoach: Record<string, string> = {};
  for (const m of memos) { const t = (m as any).employeeId; if (!lastCoach[t] || String((m as any).createdAt) > lastCoach[t]) lastCoach[t] = String((m as any).createdAt); }
  const sessByEmp: Record<string, number> = {};
  for (const x of sessions) sessByEmp[(x as any).employeeId] = Math.max(sessByEmp[(x as any).employeeId] || 0, +new Date((x as any).createdAt || 0));
  for (const [k, v] of Object.entries(sessByEmp)) { const iso = new Date(v).toISOString(); if (!lastCoach[k] || iso > lastCoach[k]) lastCoach[k] = iso; }
  const agents = emps.map((e) => {
    const mine = doneCur.filter((c) => c.employeeId === e.id);
    const sc = perEmpAvg(e.id, doneCur), scP = perEmpAvg(e.id, donePrev);
    let weakest: string | null = null, worst = 101;
    for (const c of Object.values(aC)) {
      const cell = heatmap.find((h) => h.id === e.id)?.cells[(c as any).id];
      if (cell && !cell.low && cell.rate != null && cell.rate < worst) { worst = cell.rate; weakest = (c as any).name; }
    }
    return {
      id: e.id, name: e.name, department: e.department, score: r1(sc),
      delta: sc != null && scP != null ? r1(sc - scP) : null,
      calls: mine.length, critical: mine.filter((c) => isCrit(c.id)).length,
      weakest, lastCoaching: lastCoach[e.id] || null,
    };
  });

  // ---- conversation metrics ----
  const convAgg = (rows: typeof doneCur, fn: (c: any) => number | null) => {
    const vs = rows.map(fn).filter((v): v is number => v != null);
    return vs.length ? r1(avg(vs)) : null;
  };
  const conv = {
    talkRatio: convAgg(doneCur, (c) => (c as any).talkRatio),
    deadAir: convAgg(doneCur, (c) => (c as any).deadAirPct),
    interruptions: convAgg(doneCur, (c) => (c as any).interruptions),
    aht: r1(avg(doneCur.map((c) => c.durationSec))),
    wpm: convAgg(doneCur, (c) => (c as any).agentWpm),
    outliers: emps.map((e) => {
      const m = doneCur.filter((c) => c.employeeId === e.id);
      if (!m.length) return null;
      return { id: e.id, name: e.name, talkRatio: convAgg(m, (c) => (c as any).talkRatio), deadAir: convAgg(m, (c) => (c as any).deadAirPct), interruptions: convAgg(m, (c) => (c as any).interruptions), aht: r1(avg(m.map((c) => c.durationSec))), wpm: convAgg(m, (c) => (c as any).agentWpm) };
    }).filter(Boolean),
  };

  // histogram for Analytics
  const bucketsHist = [0, 0, 0, 0, 0];
  for (const c of doneCur) bucketsHist[c.score < 50 ? 0 : c.score < 60 ? 1 : c.score < 70 ? 2 : c.score < 85 ? 3 : 4]++;
  const sorted = doneCur.map((c) => c.score).sort((a, b) => a - b);
  const median = sorted.length ? sorted[Math.floor(sorted.length / 2)] : null;

  const body = {
    range: { from: range.from.toISOString(), to: range.to.toISOString(), prevFrom: range.prevFrom.toISOString(), prevTo: range.prevTo.toISOString() },
    rules: { qaTarget: rules.qaTarget, passThreshold: rules.passThreshold, dropPoints: rules.dropPoints, criticalCount: rules.criticalCount },
    defs: DEFS,
    kpis, attention, attentionAll: items, attentionTotal: items.length,
    trend: { points: trend, target: rules.qaTarget, weekly },
    criteria,
    heatmap: { columns: Object.values(aC).map((c: any) => ({ id: c.id, name: c.name })), rows: heatmap },
    agents, conv,
    hist: { buckets: bucketsHist, median, avg: kCur.qa },
    recent: cur.slice().sort((a, b) => +new Date(b.startedAt || 0) - +new Date(a.startedAt || 0)).slice(0, 5).map((c) => ({ ...c, employeeName: empById[c.employeeId]?.name || "—" })),
    // legacy compat
    charts: { trend: trend.map((p) => ({ t: p.t, score: p.score, count: p.count })), failedCrit: criteria.map((c: any) => ({ name: c.name, fails: c.total - Math.round((c.rate ?? 100) / 100 * c.total), total: c.total })), buckets: bucketsHist },
  };
  cache.set(key, { at: Date.now(), body });
  res.json(body);
});

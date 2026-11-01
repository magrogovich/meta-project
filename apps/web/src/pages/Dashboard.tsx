import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";
import { useMemo, useState } from "react";
import { Link, useLocation } from "wouter";
import { Card, CardHeader, Pill, MetricTip, Skeleton, scoreTone, scoreColor } from "../components/ui";
import { TrendChart, Sparkline } from "../components/charts";

const iso = (d: Date) => d.toISOString().slice(0, 10);
const defRange = () => {
  const to = new Date();
  const from = new Date(to.getTime() - 30 * 864e5);
  return { from: iso(from), to: iso(to) };
};

const fmtDelta = (d: number | null, suffix = " pts") => {
  if (d == null) return "—";
  if (d === 0) return "no change";
  return `${d > 0 ? "+" : ""}${d}${suffix}`;
};

function Kpi({ label, value, delta, tip, spark, sub, onClick }: {
  label: string; value: string; delta: string; tip: string;
  spark?: { t: string; v: number | null }[]; sub?: string; onClick?: () => void;
}) {
  const up = delta.startsWith("+");
  const down = delta.startsWith("-");
  return (
    <button onClick={onClick} title={tip} className="card p-4 text-left transition hover:ring-2 hover:ring-teal-200">
      <div className="text-[11px] font-semibold uppercase tracking-wider text-gray-400">{label}<MetricTip text={tip} /></div>
      <div className="mt-1 text-2xl font-bold tracking-tight text-gray-900">{value}</div>
      <div className={`mt-0.5 text-xs font-semibold ${up ? "text-emerald-600" : down ? "text-red-600" : "text-gray-400"}`}>
        {delta === "—" || delta === "no change" ? delta : `${up ? "▲" : "▼"} ${delta} vs prev`}
      </div>
      {sub && <div className="mt-0.5 text-[11px] text-gray-500">{sub}</div>}
      {spark && <Sparkline points={spark} />}
    </button>
  );
}

const SEV_TONE: Record<string, "red" | "amber" | "gray"> = { critical: "red", warning: "amber", info: "gray" };

export function Dashboard() {
  const [, nav] = useLocation();
  const dr = useMemo(defRange, []);
  const [f, setF] = useState({ from: dr.from, to: dr.to, dept: "", lang: "" });
  const q = new URLSearchParams(Object.entries(f).filter(([, v]) => v)).toString();
  const { data, isLoading, isError, refetch } = useQuery({ queryKey: ["dash", q], queryFn: () => api(`/api/dashboard/summary?${q}`) });
  const { data: emps } = useQuery({ queryKey: ["emps"], queryFn: () => api("/api/employees") });
  const depts = [...new Set(((emps as any[]) || []).map((e) => e.department))];
  const [sortA, setSortA] = useState<{ k: string; d: 1 | -1 }>({ k: "delta", d: 1 });
  const [sortH, setSortH] = useState(false);

  const rangeNote = data?.range
    ? `Comparing ${iso(new Date(data.range.from))} → ${iso(new Date(data.range.to))} vs ${iso(new Date(data.range.prevFrom))} → ${iso(new Date(data.range.prevTo))}`
    : "";
  const rules = data?.rules || { qaTarget: 80, passThreshold: 70 };
  const defs = data?.defs || {};
  const k = data?.kpis;
  const no = (v: number | null, suffix = "") => (v == null ? "—" : `${v}${suffix}`);

  const callsLink = (extra: Record<string, string> = {}) => {
    const p = new URLSearchParams({ from: f.from, to: f.to, ...(f.lang ? { lang: f.lang } : {}), ...(f.dept ? { dept: f.dept } : {}), ...extra });
    return `/calls?${p.toString()}`;
  };

  return (
    <div className="w-full space-y-4">
      <div>
        <h1 className="text-lg font-bold tracking-tight text-gray-900">What needs my attention?</h1>
        <p className="text-xs text-gray-500">Filters apply to everything below. {rangeNote}</p>
      </div>

      <Card className="flex flex-wrap items-end gap-2 p-3">
        <div><label className="text-[11px] font-semibold text-gray-500">From</label>
          <input className="input mt-1 w-36" type="date" value={f.from} onChange={(e) => setF({ ...f, from: e.target.value })} /></div>
        <div><label className="text-[11px] font-semibold text-gray-500">To</label>
          <input className="input mt-1 w-36" type="date" value={f.to} onChange={(e) => setF({ ...f, to: e.target.value })} /></div>
        <div><label className="text-[11px] font-semibold text-gray-500">Department</label>
          <select className="input mt-1 w-36" value={f.dept} onChange={(e) => setF({ ...f, dept: e.target.value })}><option value="">all</option>{depts.map((d) => <option key={d} value={d}>{d}</option>)}</select></div>
        <div><label className="text-[11px] font-semibold text-gray-500">Language</label>
          <select className="input mt-1 w-28" value={f.lang} onChange={(e) => setF({ ...f, lang: e.target.value })}><option value="">all</option><option>en</option><option>fr</option><option>de</option><option>es</option></select></div>
      </Card>

      {isLoading ? (
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-3 xl:grid-cols-6">{[...Array(6)].map((_, i) => <Skeleton key={i} />)}</div>
      ) : isError ? (
        <Card className="p-6 text-center text-xs text-gray-600">Couldn't load the dashboard. <button className="btn ml-2" onClick={() => refetch()}>Retry</button></Card>
      ) : !k ? null : (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-3 xl:grid-cols-6">
            <Kpi label="QA score" value={no(k.qa.value)} delta={fmtDelta(k.qa.delta)} tip={defs.qaScore}
              spark={k.qa.spark} sub={`${k.qa.calls} calls analyzed · target ${rules.qaTarget}`}
              onClick={() => nav(callsLink())} />
            <Kpi label="Pass rate" value={no(k.pass.value, "%")} delta={fmtDelta(k.pass.delta, " pp")} tip={`${defs.passRate} Threshold ${rules.passThreshold}.`}
              sub={k.pass.aht != null ? `avg handle ${Math.round(k.pass.aht)}s` : undefined}
              onClick={() => nav(callsLink())} />
            <Kpi label="Critical failure rate" value={no(k.critical.value, "%")} delta={fmtDelta(k.critical.delta, " pp")} tip={defs.criticalRate}
              sub={`${k.critical.count} call(s)`} onClick={() => nav(callsLink({ critical: "1" }))} />
            <Kpi label="Customer sentiment" value={no(k.sentiment.value, "%")} delta={fmtDelta(k.sentiment.delta, " pp")} tip={defs.sentiment}
              onClick={() => nav(callsLink())} />
            <Kpi label="Resolution rate" value={no(k.resolution.value, "%")} delta={fmtDelta(k.resolution.delta, " pp")} tip={defs.resolution}
              onClick={() => nav(callsLink())} />
            <Kpi label="Coverage" value={no(k.coverage.value, "%")} delta={fmtDelta(k.coverage.delta, " pp")} tip={defs.coverage}
              sub={k.coverage.recorded ? `${k.coverage.analyzed}/${k.coverage.recorded} · manual QA reviews 1–2%` : "no calls recorded"}
              onClick={() => nav(callsLink())} />
          </div>

          <Card className="border-amber-200">
            <CardHeader title="Needs attention" sub={`${data.attentionTotal} open · ranked by severity`}
              right={<Link href="/calls" className="text-xs font-semibold text-indigo-700 hover:underline">View all</Link>} />
            {!data.attention?.length ? <p className="p-4 text-xs text-gray-500">Nothing needs your attention.</p> : (
              <ul className="divide-y divide-gray-100">
                {data.attention.map((a: any, i: number) => (
                  <li key={i}>
                    <Link href={a.link} className="flex items-center gap-3 px-4 py-2.5 hover:bg-amber-50/50">
                      <Pill tone={SEV_TONE[a.severity] || "gray"}>{a.severity}</Pill>
                      <span className="flex-1 text-xs font-medium text-gray-800">{a.text}</span>
                      {a.link.startsWith("/employees/") && (
                        <button className="btn-outline !px-2 !py-1 text-[11px]"
                          onClick={(e) => { e.preventDefault(); nav(`${a.link}`); }}>Start coaching</button>
                      )}
                      <span className="text-[11px] text-gray-400">Open →</span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <div className="grid gap-3 lg:grid-cols-2">
            <Card>
              <CardHeader title={`Score trend`} sub={data.trend.weekly ? "weekly average · dashed = target · bars = volume" : "daily average · dashed = target · bars = volume"} />
              <div className="p-4">
                <TrendChart points={data.trend.points} target={data.trend.target} weekly={data.trend.weekly} />
                <p className="mt-1 text-[11px] text-gray-400">Axes: score 0–100, date. Hover any point for date, average and call count.</p>
              </div>
            </Card>
            <Card>
              <CardHeader title="Criteria performance" sub="pass rate per criterion · worst first · click to see failures" />
              <div className="p-4">
                {!data.criteria?.length ? <p className="text-xs text-gray-400">No evaluated calls in this period.</p> : (
                  <div className="space-y-2.5">
                    {data.criteria.map((c: any) => (
                      <button key={c.id} className="block w-full text-left" title={`${c.name}: ${c.rate}% pass across ${c.total} calls`}
                        onClick={() => nav(callsLink({ failCrit: c.id }))}>
                        <div className="mb-1 flex items-baseline justify-between gap-2">
                          <span className="truncate text-xs font-medium text-gray-700">{c.name}</span>
                          <span className="shrink-0 text-xs text-gray-500">{c.rate == null ? "—" : `${c.rate}% · ${c.total} calls`}
                            {c.delta != null && <span className={c.delta >= 0 ? "text-emerald-600" : "text-red-600"}> ({c.delta >= 0 ? "+" : ""}{c.delta})</span>}</span>
                        </div>
                        <div className="h-2.5 overflow-hidden rounded-full bg-gray-100">
                          <div className="h-full rounded-full" style={{ width: `${c.rate ?? 0}%`, background: scoreColor(c.rate, rules.qaTarget, rules.passThreshold) }} />
                        </div>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </Card>
          </div>

          <Card>
            <CardHeader title="Agent × criteria" sub="cell = pass rate · gray = fewer than 3 calls · click a cell for its failed calls" />
            {!data.heatmap?.rows?.length ? <p className="p-4 text-xs text-gray-400">No data yet.</p> : (
              <div className="overflow-x-auto p-4">
                <table className="w-full min-w-[640px] text-xs">
                  <thead><tr className="border-b border-gray-100">
                    <th className="table-head px-2 py-2 text-left">
                      <button onClick={() => setSortH((s) => !s)}>Agent {sortH ? "▲" : "▼"}</button></th>
                    {data.heatmap.columns.map((c: any) => <th key={c.id} className="table-head px-2 py-2 text-center">{c.name}</th>)}
                    <th className="table-head px-2 py-2 text-right">Score</th><th className="table-head px-2 py-2 text-right">Trend</th>
                  </tr></thead>
                  <tbody className="divide-y divide-gray-50">
                    {(sortH ? [...data.heatmap.rows].reverse() : data.heatmap.rows).map((r: any) => (
                      <tr key={r.id} className="hover:bg-gray-50/60">
                        <td className="px-2 py-2 font-medium text-gray-900"><Link href={`/employees/${r.id}`} className="hover:underline">{r.name}</Link></td>
                        {data.heatmap.columns.map((c: any) => {
                          const cell = r.cells[c.id];
                          if (!cell || cell.n === 0) return <td key={c.id} className="px-2 py-2 text-center text-gray-300">—</td>;
                          if (cell.low) return <td key={c.id} title={`${r.name} · ${c.name}: low data (${cell.n} calls)`}
                            className="px-2 py-2 text-center"><span className="inline-block min-w-12 rounded bg-gray-100 px-2 py-1 text-gray-400">low</span></td>;
                          return (
                            <td key={c.id} className="px-2 py-2 text-center">
                              <button title={`${r.name} · ${c.name}: ${cell.rate}% pass (${cell.n} calls)`}
                                onClick={() => nav(callsLink({ employeeId: r.id, failCrit: c.id }))}
                                className="min-w-12 rounded px-2 py-1 font-bold text-white"
                                style={{ background: scoreColor(cell.rate, rules.qaTarget, rules.passThreshold) }}>{cell.rate}%</button>
                            </td>
                          );
                        })}
                        <td className="px-2 py-2 text-right"><Pill tone={scoreTone(r.score, rules.qaTarget, rules.passThreshold)}>{r.score ?? "—"}</Pill></td>
                        <td className="px-2 py-2 text-right font-bold text-gray-600">{r.delta == null ? "—" : <span className={r.delta >= 0 ? "text-emerald-600" : "text-red-600"}>{r.delta >= 0 ? `↗ +${r.delta}` : `↘ ${r.delta}`}</span>}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <div className="mt-2 flex items-center gap-2 text-[11px] text-gray-500">
                  <span>Pass rate:</span>
                  <span className="inline-block h-3 w-8 rounded" style={{ background: "linear-gradient(90deg,#dc2626,#d97706,#16a34a)" }} />
                  <span>red (below {rules.passThreshold}) → amber → green (≥ {rules.qaTarget})</span>
                </div>
              </div>
            )}
          </Card>

          <div className="grid gap-3 lg:grid-cols-5">
            <Card className="lg:col-span-3">
              <CardHeader title="Agents" sub="sortable · click a row for the profile" />
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead><tr className="border-b border-gray-100">
                    {([["name", "Name"], ["score", "Score"], ["delta", "Change"], ["calls", "Calls"], ["critical", "Crit"], ["weakest", "Weakest"], ["lastCoaching", "Last coaching"]] as [string, string][]).map(([kk, label]) => (
                      <th key={kk} className="table-head cursor-pointer px-3 py-2 text-left"
                        onClick={() => setSortA({ k: kk, d: sortA.k === kk && sortA.d === 1 ? -1 : 1 })}>
                        {label}{sortA.k === kk ? (sortA.d === 1 ? " ▲" : " ▼") : ""}</th>
                    ))}
                  </tr></thead>
                  <tbody className="divide-y divide-gray-100">
                    {[...(data.agents || [])].sort((a: any, b: any) => {
                      const av = a[sortA.k] ?? (sortA.k === "name" ? "" : -9999);
                      const bv = b[sortA.k] ?? (sortA.k === "name" ? "" : -9999);
                      return (av > bv ? 1 : av < bv ? -1 : 0) * sortA.d;
                    }).map((a: any) => (
                      <tr key={a.id} className="cursor-pointer hover:bg-gray-50" onClick={() => nav(`/employees/${a.id}`)}>
                        <td className="px-3 py-2.5 font-medium text-gray-900">{a.name}<span className="block text-[11px] font-normal text-gray-400">{a.department}</span></td>
                        <td className="px-3 py-2.5"><Pill tone={scoreTone(a.score, rules.qaTarget, rules.passThreshold)}>{a.score ?? "—"}</Pill></td>
                        <td className={`px-3 py-2.5 font-semibold ${a.delta == null ? "text-gray-300" : a.delta >= 0 ? "text-emerald-600" : "text-red-600"}`}>
                          {a.delta == null ? "—" : `${a.delta >= 0 ? "+" : ""}${a.delta}`}</td>
                        <td className="px-3 py-2.5 text-gray-600">{a.calls}</td>
                        <td className="px-3 py-2.5 text-gray-600">{a.critical}</td>
                        <td className="px-3 py-2.5 text-gray-500">{a.weakest || "—"}</td>
                        <td className="px-3 py-2.5 text-gray-500">{a.lastCoaching ? new Date(a.lastCoaching).toLocaleDateString() : "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {!data.agents?.length && <p className="p-4 text-xs text-gray-400">No agents in this filter.</p>}
              </div>
            </Card>
            <Card className="lg:col-span-2">
              <CardHeader title="Conversation metrics" sub="team average · computed from audio timing" />
              <div className="space-y-2.5 p-4 text-xs">
                {[
                  ["talkRatio", `Talk:listening ratio`, `Agent speaking time ÷ customer speaking time.`, data.conv.talkRatio == null ? "—" : `${data.conv.talkRatio}:1`],
                  ["deadAir", "Dead air %", "Silence ≥2s ÷ call duration.", data.conv.deadAir == null ? "—" : `${data.conv.deadAir}%`],
                  ["interruptions", "Interruptions / call", "Agent starts >0.5s before customer finishes.", data.conv.interruptions ?? "—"],
                  ["aht", "Avg handle time", "Call duration.", data.conv.aht == null ? "—" : `${Math.round(Number(data.conv.aht))}s`],
                  ["wpm", "Speaking pace", "Agent words per minute.", data.conv.wpm == null ? "—" : `${data.conv.wpm} wpm`],
                ].map(([kk, label, tip, val]) => (
                  <div key={kk} className="flex items-center justify-between gap-2 border-b border-gray-50 pb-2 last:border-0">
                    <span className="font-medium text-gray-700">{label}<MetricTip text={String(tip)} /></span>
                    <span className="font-bold text-gray-900">{val}</span>
                  </div>
                ))}
                {!!data.conv.outliers?.length && (
                  <div className="pt-1">
                    <p className="text-[11px] font-semibold text-gray-500">Outliers</p>
                    <ul className="mt-1 space-y-1">
                      {(data.conv.outliers as any[]).filter((o) =>
                        (data.conv.deadAir != null && o.deadAir != null && Math.abs(o.deadAir - data.conv.deadAir) > 8) ||
                        (data.conv.talkRatio != null && o.talkRatio != null && Math.abs(o.talkRatio - data.conv.talkRatio) > 1)
                      ).slice(0, 3).map((o: any) => (
                        <li key={o.id}><Link href={`/employees/${o.id}`} className="text-indigo-700 hover:underline">{o.name}</Link>
                          <span className="text-gray-500"> · {o.talkRatio ?? "—"}:1 talk · {o.deadAir ?? "—"}% silence</span></li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            </Card>
          </div>

          <Card>
            <CardHeader title="Recent calls" sub="latest 5 — every number links to its calls"
              right={<Link href={callsLink()} className="text-xs font-semibold text-indigo-700 hover:underline">View all</Link>} />
            <ul className="divide-y divide-gray-100">
              {(data.recent || []).map((c: any) => (
                <li key={c.id}><Link href={`/calls/${c.id}`} className="flex items-center gap-3 px-4 py-2 hover:bg-gray-50">
                  <span className="flex-1 text-xs font-medium text-gray-800">{c.employeeName} · {new Date(c.startedAt).toLocaleString()}</span>
                  <Pill tone={scoreTone(c.score, rules.qaTarget, rules.passThreshold)}>{c.score}</Pill>
                </Link></li>
              ))}
            </ul>
          </Card>
        </>
      )}
    </div>
  );
}

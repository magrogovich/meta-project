import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";
import { useState } from "react";
import { Link } from "wouter";
import { TriangleAlert, ArrowDownWideNarrow, PhoneOff, CircleX, UserX, Siren } from "lucide-react";
import { Card, CardHeader, StatCard, Pill, scoreTone, EmptyState } from "../components/ui";
import { LineChart, BarChart } from "../components/charts";

const KIND_META: Record<string, { icon: any; tone: "red" | "amber" | "gray" }> = {
  drop: { icon: ArrowDownWideNarrow, tone: "amber" },
  critical: { icon: Siren, tone: "red" },
  flag: { icon: UserX, tone: "amber" },
  failed: { icon: CircleX, tone: "red" },
  offline: { icon: PhoneOff, tone: "gray" },
};

function deltaText(d: number, suffix = "") {
  if (!d) return "—";
  return `${d > 0 ? "+" : ""}${d}${suffix}`;
}

export function Dashboard() {
  const [f, setF] = useState({ from: "", to: "", dept: "", lang: "" });
  const q = new URLSearchParams(Object.entries(f).filter(([, v]) => v)).toString();
  const { data, isLoading } = useQuery({ queryKey: ["dash", q], queryFn: () => api(`/api/dashboard/summary?${q}`) });
  const { data: emps } = useQuery({ queryKey: ["emps"], queryFn: () => api("/api/employees") });
  const depts = [...new Set(((emps as any[]) || []).map((e) => e.department))];
  const empName = (id: string) => (data?.employees || []).find((e: any) => e.id === id)?.name || "—";

  const k = data?.kpis;
  const attention: any[] = [
    ...(data?.attention?.drops || []), ...(data?.attention?.critical || []),
    ...(data?.attention?.flagged || []), ...(data?.attention?.failed || []), ...(data?.attention?.offline || []),
  ];
  const histLabels = ["<50", "50–60", "60–70", "70–85", "85+"];
  const hist = (data?.charts?.buckets || []).map((v: number, i: number) => ({ label: histLabels[i], value: v }));

  return (
    <div className="w-full space-y-4">
      <div>
        <h1 className="text-lg font-bold tracking-tight text-gray-900">What needs my attention?</h1>
        <p className="text-xs text-gray-500">Filters apply to everything below.</p>
      </div>

      <Card className="flex flex-wrap items-end gap-2 p-3">
        <div><label className="text-[11px] font-semibold text-gray-500">From</label><input className="input mt-1 w-36" type="date" value={f.from} onChange={(e) => setF({ ...f, from: e.target.value })} /></div>
        <div><label className="text-[11px] font-semibold text-gray-500">To</label><input className="input mt-1 w-36" type="date" value={f.to} onChange={(e) => setF({ ...f, to: e.target.value })} /></div>
        <div><label className="text-[11px] font-semibold text-gray-500">Department</label>
          <select className="input mt-1 w-36" value={f.dept} onChange={(e) => setF({ ...f, dept: e.target.value })}><option value="">all</option>{depts.map((d) => <option key={d} value={d}>{d}</option>)}</select></div>
        <div><label className="text-[11px] font-semibold text-gray-500">Language</label>
          <select className="input mt-1 w-28" value={f.lang} onChange={(e) => setF({ ...f, lang: e.target.value })}><option value="">all</option><option>en</option><option>fr</option><option>de</option><option>es</option></select></div>
      </Card>

      {isLoading || !k ? <p className="text-xs text-gray-500">Loading…</p> : (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-3 xl:grid-cols-6">
            <StatCard label="Calls analyzed" value={String(k.calls.value)} hint={`Δ ${deltaText(k.calls.delta)} vs prev`} />
            <StatCard label="Average score" value={k.avg.value ?? "—"} hint={`Δ ${deltaText(k.avg.delta)} vs prev`} />
            <StatCard label="Critical failures" value={String(k.critical.value)} hint="must-pass criterion failed" />
            <StatCard label="Needing coaching" value={String(k.needCoach.value)} hint="score below 70" />
            <StatCard label="Coverage" value={k.coverage.value != null ? `${k.coverage.value}%` : "—"} hint={`${k.coverage.agentsOnline}/${k.coverage.agentsTotal} agents online`} />
            <StatCard label="Follow-through" value={k.follow.value != null ? `${k.follow.value}%` : "—"} hint="action items done" />
          </div>

          <Card className="border-amber-200">
            <CardHeader title="Needs attention" sub={`${attention.length} open items`} />
            {!attention.length ? <p className="p-4 text-xs text-gray-500">All clear. Nothing needs you right now.</p> : (
              <ul className="divide-y divide-gray-100">
                {attention.map((a: any, i: number) => {
                  const m = KIND_META[a.kind] || KIND_META.offline;
                  return (
                    <li key={i}>
                      <Link href={a.link} className="flex items-center gap-3 px-4 py-2.5 hover:bg-amber-50/50">
                        <Pill tone={m.tone}><m.icon className="h-3 w-3" /></Pill>
                        <span className="flex-1 text-xs font-medium text-gray-800">{a.text}</span>
                        <span className="text-[11px] text-gray-400">Open →</span>
                      </Link>
                    </li>
                  );
                })}
              </ul>
            )}
          </Card>

          <div className="grid gap-3 lg:grid-cols-2">
            <Card>
              <CardHeader title="Team score trend" sub="daily average" />
              <div className="p-4"><LineChart points={data.charts.trend} /></div>
            </Card>
            <Card>
              <CardHeader title="Most-failed criteria" sub="fail count" />
              <div className="p-4"><BarChart bars={data.charts.failedCrit.map((c: any) => ({ label: c.name.split(" ")[0], value: c.fails }))} color="#DC2626" /></div>
            </Card>
          </div>

          <div className="grid gap-3 lg:grid-cols-3">
            <Card>
              <CardHeader title="Score distribution" sub="analyzed calls" />
              <div className="p-4"><BarChart bars={hist} color="#4F39F6" /></div>
            </Card>
            <Card>
              <CardHeader title="Top improvers" sub="vs previous period" />
              {!data.improvers.length ? <p className="p-4 text-xs text-gray-400">No data yet</p> : (
                <ul className="divide-y divide-gray-100">
                  {data.improvers.map((e: any) => (
                    <li key={e.id}><Link href={`/employees/${e.id}`} className="flex items-center justify-between px-4 py-2 hover:bg-gray-50">
                      <span className="text-xs font-medium text-gray-800">{e.name}</span>
                      <span className="text-xs font-semibold text-emerald-600">+{e.delta}</span>
                    </Link></li>))}
                </ul>)}
            </Card>
            <Card>
              <CardHeader title="Biggest declines" sub="vs previous period" />
              {!data.declines.length ? <p className="p-4 text-xs text-gray-400">No data yet</p> : (
                <ul className="divide-y divide-gray-100">
                  {data.declines.map((e: any) => (
                    <li key={e.id}><Link href={`/employees/${e.id}`} className="flex items-center justify-between px-4 py-2 hover:bg-gray-50">
                      <span className="text-xs font-medium text-gray-800">{e.name}</span>
                      <span className="flex items-center gap-1 text-xs font-semibold text-red-600"><TriangleAlert className="h-3 w-3" />{e.delta}</span>
                    </Link></li>))}
                </ul>)}
            </Card>
          </div>

          <Card>
            <CardHeader title="Recent calls" sub="latest 5" right={<Link href="/calls" className="text-xs font-semibold text-indigo-700 hover:underline">View all →</Link>} />
            {!data.recent.length ? <div className="p-4"><EmptyState title="No calls yet" hint="Seeded calls appear here, or install the desktop agent." /></div> : (
              <ul className="divide-y divide-gray-100">
                {data.recent.map((c: any) => (
                  <li key={c.id}>
                    <Link href={`/calls/${c.id}`} className="flex items-center gap-3 px-4 py-2.5 hover:bg-gray-50">
                      <span className="min-w-0 flex-1 truncate text-xs font-medium text-gray-800">{empName(c.employeeId)} · {new Date(c.startedAt).toLocaleString()}</span>
                      <Pill tone={c.status === "done" ? "green" : c.status === "failed" ? "red" : "amber"}>{c.status}</Pill>
                      <Pill tone={scoreTone(c.score)}>{c.score}</Pill>
                    </Link>
                  </li>))}
              </ul>)}
          </Card>
        </>
      )}
    </div>
  );
}

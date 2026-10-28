import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import { useState } from "react";
import { Link } from "wouter";
import { Users, PhoneCall, Gauge, TriangleAlert, Plus } from "lucide-react";
import { Card, CardHeader, StatCard, Pill, scoreTone, EmptyState } from "../components/ui";
import { LineChart, BarChart } from "../components/charts";

export function Dashboard() {
  const qc = useQueryClient();
  const { data: emps, isLoading } = useQuery({ queryKey: ["emps"], queryFn: () => api("/api/employees") });
  const { data: calls } = useQuery({ queryKey: ["calls"], queryFn: () => api("/api/calls") });
  const [form, setForm] = useState({ name: "", department: "Support", languages: "en" });
  const [showAdd, setShowAdd] = useState(false);
  const [lastKey, setLastKey] = useState("");
  const create = useMutation({
    mutationFn: () => api("/api/employees", { method: "POST", body: JSON.stringify({ ...form, languages: form.languages.split(",").map((s) => s.trim()) }) }),
    onSuccess: (r) => { setLastKey(r.sessionKey); setShowAdd(false); setForm({ name: "", department: "Support", languages: "en" }); qc.invalidateQueries({ queryKey: ["emps"] }); },
  });

  const list: any[] = emps || [];
  const callList: any[] = calls || [];
  const done = callList.filter((c) => c.status === "done");
  const avg = done.length ? Math.round(done.reduce((a, c) => a + c.score, 0) / done.length * 10) / 10 : 0;
  const needCoach = list.filter((e) => (e.overallScore || 0) < 70).length;
  const trendPts = callList.slice().sort((a, b) => +new Date(a.startedAt) - +new Date(b.startedAt)).slice(-20).map((c) => ({ t: c.startedAt, score: c.score }));
  const byEmp = list.slice(0, 8).map((e) => ({ label: e.name.split(" ")[0], value: Math.round(e.overallScore || 0) }));
  const recent = callList.slice(0, 10);
  const empName = (id: string) => list.find((e) => e.id === id)?.name || "—";

  return (
    <div className="mx-auto w-full max-w-6xl space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="text-lg font-bold tracking-tight text-gray-900">Dashboard</h1>
          <p className="text-xs text-gray-500">AI QA over 100% of calls. AI assists, humans decide.</p>
        </div>
        <div className="flex gap-2">
          <Link href="/scorecard" className="btn-outline">QA scorecard</Link>
          <button className="btn" onClick={() => setShowAdd((s) => !s)}><Plus className="h-4 w-4" /> Add employee</button>
        </div>
      </div>

      {lastKey && (
        <Card className="border-indigo-200 bg-indigo-50/50 p-4">
          <div className="text-xs font-semibold text-gray-900">Session key — shown once, copy now:</div>
          <code className="mt-1 block break-all rounded-md bg-white p-2 text-xs ring-1 ring-indigo-200">{lastKey}</code>
        </Card>
      )}

      {showAdd && (
        <Card className="p-4">
          <div className="flex flex-wrap items-end gap-2">
            <div><label className="text-[11px] font-semibold text-gray-500">Name</label><input className="input mt-1 w-52" placeholder="Jane Doe" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></div>
            <div><label className="text-[11px] font-semibold text-gray-500">Department</label><input className="input mt-1 w-40" value={form.department} onChange={(e) => setForm({ ...form, department: e.target.value })} /></div>
            <div><label className="text-[11px] font-semibold text-gray-500">Languages</label><input className="input mt-1 w-40" placeholder="en,fr" value={form.languages} onChange={(e) => setForm({ ...form, languages: e.target.value })} /></div>
            <button className="btn" disabled={!form.name} onClick={() => create.mutate()}>Create + get key</button>
          </div>
        </Card>
      )}

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard label="Employees" value={String(list.length)} hint="tracked agents" icon={<Users className="h-4 w-4 text-gray-400" />} />
        <StatCard label="Calls analyzed" value={String(done.length)} hint={`of ${callList.length} total`} icon={<PhoneCall className="h-4 w-4 text-gray-400" />} />
        <StatCard label="Avg score" value={done.length ? String(avg) : "—"} hint="across analyzed calls" icon={<Gauge className="h-4 w-4 text-gray-400" />} />
        <StatCard label="Needs coaching" value={String(needCoach)} hint="scoring below 70" icon={<TriangleAlert className="h-4 w-4 text-gray-400" />} />
      </div>

      <div className="grid gap-3 lg:grid-cols-2">
        <Card>
          <CardHeader title="Score trend" sub="last 20 analyzed calls" />
          <div className="p-4"><LineChart points={trendPts} /></div>
        </Card>
        <Card>
          <CardHeader title="Score by employee" sub="overall average" />
          <div className="p-4"><BarChart bars={byEmp} /></div>
        </Card>
      </div>

      <Card>
        <CardHeader title="Employees" sub="overall score + trend vs previous period" right={<span className="text-xs text-gray-400">{list.length} total</span>} />
        {isLoading ? <p className="p-4 text-xs text-gray-500">Loading…</p> : !list.length ? (
          <div className="p-4"><EmptyState title="No employees yet" hint="Add your first employee to get a session key for the desktop agent." action={<button className="btn" onClick={() => setShowAdd(true)}>Add employee</button>} /></div>
        ) : (
          <ul className="divide-y divide-gray-100">
            {list.map((e: any) => (
              <li key={e.id}>
                <Link href={`/employees/${e.id}`} className="flex items-center gap-3 px-4 py-3 hover:bg-gray-50">
                  <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-gray-900 text-xs font-bold text-white">{e.name[0]}</div>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-semibold text-gray-900">{e.name}</div>
                    <div className="truncate text-xs text-gray-500">{e.department} · {(e.languages || []).join(", ")}</div>
                  </div>
                  <span className="text-xs font-medium text-gray-500">{e.trend > 0 ? `↗ +${e.trend}` : e.trend < 0 ? `↘ ${e.trend}` : "→ 0"}</span>
                  <Pill tone={scoreTone(e.overallScore || 0)}>{e.overallScore || "—"}</Pill>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card>
        <CardHeader title="Recent calls" sub="click a row for transcript + evidence" />
        {!recent.length ? <div className="p-4"><EmptyState title="No calls yet" hint="Seeded calls appear here, or install the desktop agent to upload real ones." /></div> : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead><tr className="border-b border-gray-100">
                <th className="table-head px-4 py-2">Employee</th><th className="table-head px-2 py-2">Date</th>
                <th className="table-head px-2 py-2">Dur</th><th className="table-head px-2 py-2">Lang</th>
                <th className="table-head px-2 py-2">Status</th><th className="table-head px-2 py-2 text-right">Score</th>
              </tr></thead>
              <tbody className="divide-y divide-gray-100">
                {recent.map((c: any) => (
                  <tr key={c.id} className="hover:bg-gray-50">
                    <td className="px-4 py-2.5 font-medium text-gray-900"><Link className="hover:underline" href={`/calls/${c.id}`}>{empName(c.employeeId)}</Link></td>
                    <td className="whitespace-nowrap px-2 py-2.5 text-gray-500">{new Date(c.startedAt).toLocaleString()}</td>
                    <td className="px-2 py-2.5 text-gray-500">{c.durationSec}s</td>
                    <td className="px-2 py-2.5 text-gray-500">{c.language}</td>
                    <td className="px-2 py-2.5"><Pill tone={c.status === "done" ? "green" : c.status === "failed" ? "red" : "amber"}>{c.status}</Pill></td>
                    <td className="px-2 py-2.5 text-right"><Pill tone={scoreTone(c.score)}>{c.score}</Pill></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api, scoreColor } from "../lib/api";
import { useState } from "react";
import { Link } from "wouter";

export function Dashboard({ onHelp }: { onHelp: () => void }) {
  const qc = useQueryClient();
  const { data: emps, isLoading } = useQuery({ queryKey: ["emps"], queryFn: () => api("/api/employees") });
  const [form, setForm] = useState({ name: "", department: "Support", languages: "en" });
  const [lastKey, setLastKey] = useState("");
  const create = useMutation({
    mutationFn: () => api("/api/employees", { method: "POST", body: JSON.stringify({ ...form, languages: form.languages.split(",").map((s) => s.trim()) }) }),
    onSuccess: (r) => { setLastKey(r.sessionKey); qc.invalidateQueries({ queryKey: ["emps"] }); },
  });
  return (
    <div className="p-6 max-w-6xl mx-auto">
      <header className="flex items-center justify-between">
        <div><h1 className="text-2xl font-bold text-cyan-900">Employees</h1>
        <p className="text-xs text-slate-500">AI assists, humans decide. <button className="underline" onClick={onHelp}>Help / walkthrough</button></p></div>
        <nav className="flex gap-2 text-sm"><Link href="/scorecard" className="btn-ghost">Scorecard</Link><button className="btn-ghost" onClick={() => { localStorage.removeItem("token"); location.href = "/login"; }}>Logout</button></nav>
      </header>
      {lastKey && <div className="card p-4 mt-4 border-teal-300"><b>Session key (shown once — copy now):</b><code className="block mt-1 break-all bg-slate-100 p-2 rounded">{lastKey}</code></div>}
      <div className="card p-4 mt-4 flex flex-wrap gap-2 items-end">
        <input className="input max-w-52" placeholder="Name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        <input className="input max-w-40" placeholder="Dept" value={form.department} onChange={(e) => setForm({ ...form, department: e.target.value })} />
        <input className="input max-w-40" placeholder="langs en,fr" value={form.languages} onChange={(e) => setForm({ ...form, languages: e.target.value })} />
        <button className="btn" onClick={() => create.mutate()}>Add employee</button>
      </div>
      {isLoading ? <p className="mt-4">Loading…</p> : !emps?.length ? (
        <div className="card p-8 mt-4 text-center text-slate-500">No employees yet — add your first employee above, then copy their session key.</div>
      ) : (
        <div className="grid md:grid-cols-3 gap-4 mt-4">
          {emps.map((e: any) => (
            <Link key={e.id} href={`/employees/${e.id}`} className="card p-4 hover:shadow">
              <div className="flex items-center gap-3">
                <div className="w-12 h-12 rounded-full bg-cyan-100 grid place-items-center font-bold text-cyan-800">{e.name[0]}</div>
                <div><div className="font-semibold">{e.name}</div><div className="text-xs text-slate-500">{e.department} · {(e.languages || []).join(", ")}</div></div>
              </div>
              <div className="mt-3 flex items-center gap-2">
                <span className={`badge ${scoreColor(e.overallScore)}`}>{e.overallScore || "—"}</span>
                <span className="text-sm">{e.trend > 0 ? "↗ +" : e.trend < 0 ? "↘ " : "→ "}{e.trend ?? 0}</span>
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}

export function Trend({ points }: { points: { t: string; score: number }[] }) {
  if (!points?.length) return <p className="text-sm text-slate-400">No trend yet.</p>;
  const w = 300, h = 80;
  const xs = (i: number) => (i / Math.max(1, points.length - 1)) * (w - 10) + 5;
  const ys = (s: number) => h - 5 - (s / 100) * (h - 10);
  return (
    <svg width={w} height={h} className="bg-slate-50 rounded border">
      <polyline fill="none" stroke="#0e7490" strokeWidth="2" points={points.map((p, i) => `${xs(i)},${ys(p.score)}`).join(" ")} />
      {points.map((p, i) => <circle key={i} cx={xs(i)} cy={ys(p.score)} r="3" fill="#0e7490" />)}
    </svg>
  );
}

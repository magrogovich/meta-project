import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";
import { useState } from "react";
import { Link } from "wouter";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { Card, Pill, scoreTone, EmptyState } from "../components/ui";

const flagTone = (f: string): "red" | "amber" | "gray" => (f === "critical" || f === "failed" ? "red" : f === "low" ? "amber" : "gray");

export function Calls() {
  const [f, setF] = useState({ from: "", to: "", employeeId: "", dept: "", lang: "", min: "", max: "", critical: false, failed: false, page: 1, sort: "startedAt", order: "desc" as "asc" | "desc" });
  const set = (p: Partial<typeof f>) => setF({ ...f, ...p, ...(p.page === undefined ? {} : {}) });
  const resetPage = (p: Partial<typeof f>) => setF({ ...f, ...p, page: 1 });
  const q = new URLSearchParams(
    Object.entries({ ...f, critical: f.critical ? "1" : "", failed: f.failed ? "1" : "", page: String(f.page) }).filter(([, v]) => v),
  ).toString();
  const { data, isLoading } = useQuery({ queryKey: ["calls-search", q], queryFn: () => api(`/api/calls/search?${q}`) });
  const { data: emps } = useQuery({ queryKey: ["emps"], queryFn: () => api("/api/employees") });
  const depts = [...new Set(((emps as any[]) || []).map((e) => e.department))];
  const rows: any[] = data?.rows || [];
  const total = data?.total || 0;
  const pages = Math.max(1, Math.ceil(total / (data?.limit || 20)));

  const sortBy = (key: string) =>
    resetPage({ sort: key, order: f.sort === key && f.order === "desc" ? "asc" : "desc" });
  const arrow = (key: string) => (f.sort === key ? (f.order === "desc" ? " ↓" : " ↑") : "");

  return (
    <div className="w-full space-y-4">
      <div>
        <h1 className="text-lg font-bold tracking-tight text-gray-900">Calls</h1>
        <p className="text-xs text-gray-500">{total} matching · click a row for transcript + evidence</p>
      </div>

      <Card className="flex flex-wrap items-end gap-2 p-3">
        <div><label className="text-[11px] font-semibold text-gray-500">From</label><input className="input mt-1 w-36" type="date" value={f.from} onChange={(e) => resetPage({ from: e.target.value })} /></div>
        <div><label className="text-[11px] font-semibold text-gray-500">To</label><input className="input mt-1 w-36" type="date" value={f.to} onChange={(e) => resetPage({ to: e.target.value })} /></div>
        <div><label className="text-[11px] font-semibold text-gray-500">Employee</label>
          <select className="input mt-1 w-40" value={f.employeeId} onChange={(e) => resetPage({ employeeId: e.target.value })}>
            <option value="">all</option>{((emps as any[]) || []).map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}</select></div>
        <div><label className="text-[11px] font-semibold text-gray-500">Department</label>
          <select className="input mt-1 w-32" value={f.dept} onChange={(e) => resetPage({ dept: e.target.value })}>
            <option value="">all</option>{depts.map((d) => <option key={d} value={d}>{d}</option>)}</select></div>
        <div><label className="text-[11px] font-semibold text-gray-500">Language</label>
          <select className="input mt-1 w-24" value={f.lang} onChange={(e) => resetPage({ lang: e.target.value })}><option value="">all</option><option>en</option><option>fr</option><option>de</option><option>es</option></select></div>
        <div><label className="text-[11px] font-semibold text-gray-500">Min</label><input className="input mt-1 w-20" type="number" value={f.min} onChange={(e) => resetPage({ min: e.target.value })} /></div>
        <div><label className="text-[11px] font-semibold text-gray-500">Max</label><input className="input mt-1 w-20" type="number" value={f.max} onChange={(e) => resetPage({ max: e.target.value })} /></div>
        <label className="flex items-center gap-1.5 text-xs text-gray-600"><input type="checkbox" checked={f.critical} onChange={(e) => resetPage({ critical: e.target.checked })} className="h-4 w-4 accent-gray-900" /> Critical only</label>
        <label className="flex items-center gap-1.5 text-xs text-gray-600"><input type="checkbox" checked={f.failed} onChange={(e) => resetPage({ failed: e.target.checked })} className="h-4 w-4 accent-gray-900" /> Failed only</label>
      </Card>

      <Card>
        {isLoading ? <p className="p-4 text-xs text-gray-500">Loading…</p> : !rows.length ? (
          <div className="p-4"><EmptyState title="No calls match" hint="Adjust or clear the filters." /></div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead><tr className="border-b border-gray-100">
                <th className="table-head px-4 py-2">Employee</th>
                <th className="table-head cursor-pointer px-2 py-2" onClick={() => sortBy("startedAt")}>Date{arrow("startedAt")}</th>
                <th className="table-head cursor-pointer px-2 py-2 text-right" onClick={() => sortBy("duration")}>Dur{arrow("duration")}</th>
                <th className="table-head px-2 py-2">Lang</th>
                <th className="table-head cursor-pointer px-2 py-2 text-right" onClick={() => sortBy("score")}>Score{arrow("score")}</th>
                <th className="table-head px-2 py-2">Flags</th>
                <th className="table-head px-2 py-2">Status</th>
              </tr></thead>
              <tbody className="divide-y divide-gray-100">
                {rows.map((c: any) => (
                  <tr key={c.id} className="hover:bg-gray-50">
                    <td className="px-4 py-2.5 font-medium text-gray-900"><Link className="hover:underline" href={`/calls/${c.id}`}>{c.employeeName}</Link>
                      <span className="block text-[11px] font-normal text-gray-400">{c.department}</span></td>
                    <td className="whitespace-nowrap px-2 py-2.5 text-gray-500">{new Date(c.startedAt).toLocaleString()}</td>
                    <td className="px-2 py-2.5 text-right text-gray-500">{c.durationSec}s</td>
                    <td className="px-2 py-2.5 text-gray-500">{c.language}</td>
                    <td className="px-2 py-2.5 text-right"><Pill tone={scoreTone(c.score)}>{c.score}</Pill></td>
                    <td className="px-2 py-2.5"><span className="flex gap-1">{c.flags.map((fl: string) => <Pill key={fl} tone={flagTone(fl)}>{fl}</Pill>)}</span></td>
                    <td className="px-2 py-2.5"><Pill tone={c.status === "done" ? "green" : c.status === "failed" ? "red" : "amber"}>{c.status}</Pill></td>
                  </tr>))}
              </tbody>
            </table>
          </div>
        )}
        <div className="flex items-center justify-between border-t border-gray-100 px-4 py-2 text-xs text-gray-500">
          <span>Page {f.page} of {pages} ({total} calls)</span>
          <span className="flex gap-1">
            <button className="btn-outline !px-2 !py-1" disabled={f.page <= 1} onClick={() => set({ page: f.page - 1 })}><ChevronLeft className="h-3.5 w-3.5" /></button>
            <button className="btn-outline !px-2 !py-1" disabled={f.page >= pages} onClick={() => set({ page: f.page + 1 })}><ChevronRight className="h-3.5 w-3.5" /></button>
          </span>
        </div>
      </Card>
    </div>
  );
}

import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";
import { useMemo, useState } from "react";
import { Link, useLocation } from "wouter";
import { Card, CardHeader, Pill, Skeleton } from "../components/ui";

const iso = (d: Date) => d.toISOString().slice(0, 10);
const defRange = () => {
  const to = new Date();
  const from = new Date(to.getTime() - 30 * 864e5);
  return { from: iso(from), to: iso(to) };
};

const SEV_TONE: Record<string, "red" | "amber" | "gray"> = { critical: "red", warning: "amber", info: "gray" };

export function Attention() {
  const [, nav] = useLocation();
  const dr = useMemo(defRange, []);
  const [f, setF] = useState({ from: dr.from, to: dr.to, dept: "", lang: "", sev: "" });
  const q = new URLSearchParams(Object.entries({ from: f.from, to: f.to, dept: f.dept, lang: f.lang }).filter(([, v]) => v)).toString();
  const { data, isLoading, isError, refetch } = useQuery({ queryKey: ["attention", q], queryFn: () => api(`/api/dashboard/summary?${q}`) });
  const { data: emps } = useQuery({ queryKey: ["emps"], queryFn: () => api("/api/employees") });
  const depts = [...new Set(((emps as any[]) || []).map((e) => e.department))];

  const rangeNote = data?.range
    ? `Comparing ${iso(new Date(data.range.from))} → ${iso(new Date(data.range.to))} vs ${iso(new Date(data.range.prevFrom))} → ${iso(new Date(data.range.prevTo))}`
    : "";
  const all: any[] = data?.attentionAll || [];
  const list = f.sev ? all.filter((a) => a.severity === f.sev) : all;
  const counts = {
    critical: all.filter((a) => a.severity === "critical").length,
    warning: all.filter((a) => a.severity === "warning").length,
    info: all.filter((a) => a.severity === "info").length,
  };

  return (
    <div className="w-full space-y-4">
      <div>
        <h1 className="text-lg font-bold tracking-tight text-gray-900">Needs attention</h1>
        <p className="text-xs text-gray-500">Ranked by severity. {rangeNote}</p>
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
        <div><label className="text-[11px] font-semibold text-gray-500">Severity</label>
          <select className="input mt-1 w-32" value={f.sev} onChange={(e) => setF({ ...f, sev: e.target.value })}>
            <option value="">all ({all.length})</option>
            <option value="critical">critical ({counts.critical})</option>
            <option value="warning">warning ({counts.warning})</option>
            <option value="info">info ({counts.info})</option>
          </select></div>
      </Card>

      {isLoading ? <Skeleton className="h-64" /> : isError ? (
        <Card className="p-6 text-center text-xs text-gray-600">Couldn't load attention items. <button className="btn ml-2" onClick={() => refetch()}>Retry</button></Card>
      ) : (
        <Card className="border-amber-200">
          <CardHeader title="Open items" sub={`${list.length} shown · ranked by severity`} />
          {!list.length ? <p className="p-4 text-xs text-gray-500">Nothing needs your attention.</p> : (
            <ul className="divide-y divide-gray-100">
              {list.map((a: any, i: number) => (
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
      )}
    </div>
  );
}

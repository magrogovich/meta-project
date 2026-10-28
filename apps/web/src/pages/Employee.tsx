import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api, API } from "../lib/api";
import { useState, useRef } from "react";
import { Link, useRoute, useLocation } from "wouter";
import { ArrowLeft, KeyRound, FileText, Mic, Play } from "lucide-react";
import { Card, CardHeader, Pill, scoreTone, EmptyState } from "../components/ui";
import { LineChart } from "../components/charts";

export function EmployeeProfile() {
  const [, params] = useRoute("/employees/:id");
  const id = params?.id || "";
  const [, nav] = useLocation();
  const [f, setF] = useState({ from: "", to: "", lang: "", min: "", max: "" });
  const q = new URLSearchParams(Object.entries(f).filter(([, v]) => v)).toString();
  const { data, isLoading } = useQuery({ queryKey: ["profile", id, q], queryFn: () => api(`/api/employees/${id}/profile?${q}`) });
  const qc = useQueryClient();
  const [regen, setRegen] = useState("");
  const [memo, setMemo] = useState<any>(null);
  const regenKey = useMutation({ mutationFn: () => api(`/api/employees/${id}/key`, { method: "POST" }), onSuccess: (r) => setRegen(r.sessionKey) });
  const genMemo = useMutation({ mutationFn: () => api("/api/memos/generate", { method: "POST", body: JSON.stringify({ employeeId: id, from: f.from, to: f.to }) }), onSuccess: setMemo });
  const [coachTopics, setCoachTopics] = useState("");
  const startCoach = useMutation({ mutationFn: () => api("/api/coach", { method: "POST", body: JSON.stringify({ employeeId: id, topics: coachTopics }) }), onSuccess: (r) => nav(`/coach/${r.id}?token=${r.token}`) });
  if (isLoading) return <p className="p-4 text-xs text-gray-500">Loading…</p>;
  if (!data) return <p className="p-4 text-xs">Not found</p>;
  const e = data.employee;
  return (
    <div className="mx-auto w-full max-w-6xl space-y-4">
      <Link href="/" className="inline-flex items-center gap-1 text-xs font-medium text-gray-500 hover:text-gray-900"><ArrowLeft className="h-3.5 w-3.5" /> Employees</Link>
      <Card className="p-5">
        <div className="flex flex-wrap items-center gap-5">
          <div className="flex h-16 w-16 items-center justify-center rounded-full bg-gray-900 text-xl font-bold text-white">{e.name[0]}</div>
          <div className="min-w-52 flex-1">
            <h1 className="text-lg font-bold tracking-tight text-gray-900">{e.name}</h1>
            <p className="text-xs text-gray-500">{e.department} · {(e.languages || []).join(", ")}</p>
            <div className="mt-2 grid gap-1 text-xs sm:grid-cols-2">
              <p><span className="font-semibold text-emerald-700">Strengths:</span> <span className="text-gray-600">{data.strengths?.join("; ") || "—"}</span></p>
              <p><span className="font-semibold text-red-600">Weaknesses:</span> <span className="text-gray-600">{data.weaknesses?.join("; ") || "—"}</span></p>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <Pill tone={scoreTone(e.overallScore || 0)}><span className="text-base">{e.overallScore}</span></Pill>
          </div>
        </div>
        <div className="mt-4"><LineChart points={data.trend} /></div>
      </Card>

      <Card className="p-4">
        <div className="flex flex-wrap items-end gap-2">
          <div><label className="text-[11px] font-semibold text-gray-500">From</label><input className="input mt-1 w-36" type="date" value={f.from} onChange={(ev) => setF({ ...f, from: ev.target.value })} /></div>
          <div><label className="text-[11px] font-semibold text-gray-500">To</label><input className="input mt-1 w-36" type="date" value={f.to} onChange={(ev) => setF({ ...f, to: ev.target.value })} /></div>
          <div><label className="text-[11px] font-semibold text-gray-500">Language</label>
            <select className="input mt-1 w-28" value={f.lang} onChange={(ev) => setF({ ...f, lang: ev.target.value })}><option value="">all</option><option>en</option><option>fr</option><option>de</option><option>es</option></select></div>
          <div className="flex flex-1 flex-wrap gap-2">
            <input className="input mt-1 max-w-56 flex-1" placeholder="coach focus topics" value={coachTopics} onChange={(ev) => setCoachTopics(ev.target.value)} />
            <button className="btn" onClick={() => startCoach.mutate()}><Mic className="h-3.5 w-3.5" /> Start AI coaching</button>
            <button className="btn-outline" onClick={() => genMemo.mutate()}><FileText className="h-3.5 w-3.5" /> Coaching memo</button>
            <button className="btn-outline" onClick={() => regenKey.mutate()}><KeyRound className="h-3.5 w-3.5" /> New session key</button>
          </div>
        </div>
        {regen && <p className="mt-2 break-all rounded-md bg-amber-50 p-2 text-xs ring-1 ring-amber-200">New key (shown once): <code>{regen}</code></p>}
      </Card>

      {memo && <MemoCard memo={memo} />}

      <Card>
        <CardHeader title="Calls" sub={`${data.calls.length} in filter`} />
        {!data.calls.length ? <div className="p-4"><EmptyState title="No calls in this filter" hint="Upload via the desktop agent or adjust the filters." /></div> : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead><tr className="border-b border-gray-100">
                <th className="table-head px-4 py-2">Date</th><th className="table-head px-2 py-2">Dur</th>
                <th className="table-head px-2 py-2">Lang</th><th className="table-head px-2 py-2">Status</th>
                <th className="table-head px-2 py-2 text-right">Score</th>
              </tr></thead>
              <tbody className="divide-y divide-gray-100">
                {data.calls.map((c: any) => (
                  <tr key={c.id} className="hover:bg-gray-50">
                    <td className="px-4 py-2.5 font-medium text-gray-900"><Link className="hover:underline" href={`/calls/${c.id}`}>{new Date(c.startedAt).toLocaleString()}</Link></td>
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

export function MemoCard({ memo }: { memo: any }) {
  const c = memo.content;
  return (
    <Card className="p-5 text-xs" >
      <h3 className="text-sm font-bold text-gray-900">Coaching memo — {c.employee} ({c.period})</h3>
      <p className="mt-1 text-gray-600">{c.summary}</p>
      <p className="mt-3 font-semibold text-gray-900">Top issues</p>
      <ul className="ml-4 list-disc text-gray-600">{(c.topIssues || []).map((t: any, i: number) => <li key={i}>{t.text || t}</li>)}</ul>
      <p className="mt-2 font-semibold text-gray-900">Action plan</p>
      <ul className="ml-4 list-disc text-gray-600">{(c.actionPlan || []).map((t: string, i: number) => <li key={i}>{t}</li>)}</ul>
      <p className="mt-2 font-semibold text-gray-900">Practice phrases</p>
      <ul className="ml-4 list-disc text-gray-600">{(c.phrases || []).map((t: string, i: number) => <li key={i}><i>“{t}”</i></li>)}</ul>
      <button className="btn mt-3" onClick={() => window.print()}>Export PDF (print)</button>
    </Card>
  );
}

export function CallDetail() {
  const [, params] = useRoute("/calls/:id");
  const id = params?.id || "";
  const audioRef = useRef<HTMLAudioElement>(null);
  const { data: c, isLoading, refetch } = useQuery({ queryKey: ["call", id], queryFn: () => api(`/api/calls/${id}`), refetchInterval: (q: any) => (["uploaded", "transcribing", "analyzing"].includes(q?.state?.data?.status) ? 2000 : false) });
  if (isLoading) return <p className="p-4 text-xs text-gray-500">Loading…</p>;
  const seek = (s: number) => { if (audioRef.current) { audioRef.current.currentTime = s; audioRef.current.play(); } };
  return (
    <div className="mx-auto w-full max-w-6xl space-y-4">
      <Link href={c ? `/employees/${c.employeeId}` : "/"} className="inline-flex items-center gap-1 text-xs font-medium text-gray-500 hover:text-gray-900"><ArrowLeft className="h-3.5 w-3.5" /> Back to employee</Link>
      <Card className="p-4">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-bold text-gray-900">Call {id.slice(0, 8)}</span>
          <Pill tone={c.status === "done" ? "green" : c.status === "failed" ? "red" : "amber"}>{c.status}</Pill>
          <Pill tone={scoreTone(c.score)}>{c.score}</Pill>
          <span className="text-xs text-gray-500">{c.language} · scorecard v{c.scorecardVersion}</span>
          <button className="btn-outline ml-auto" onClick={async () => { await api(`/api/calls/${id}/rerun`, { method: "POST" }); setTimeout(() => refetch(), 2500); }}>Re-run analysis</button>
        </div>
        <audio ref={audioRef} controls className="mt-3 w-full" src={`${API}/api/calls/audio/${c.audioFile}`} />
        <p className="mt-2 text-xs text-gray-700">{c.summary}</p>
        <p className="mt-1 text-[11px] text-gray-500">Went well: {(c.wentWell || []).join(" · ") || "—"}</p>
        <p className="text-[11px] text-gray-500">Went wrong: {(c.wentWrong || []).join(" · ") || "—"} · Tags: {(c.tags || []).join(", ")}</p>
      </Card>
      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader title="Transcript" sub="click a line to seek" />
          <div className="max-h-[480px] overflow-y-auto p-2">
            {(c.transcript || []).map((l: any, i: number) => (
              <button key={i} onClick={() => seek(l.start)} className="flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left text-xs hover:bg-gray-50">
                <span className={`badge mt-0.5 shrink-0 ${l.speaker === "Agent" ? "bg-indigo-50 text-indigo-700 ring-1 ring-indigo-200" : "bg-gray-100 text-gray-600"}`}>{l.speaker} {l.start.toFixed(1)}s</span>
                <span className="text-gray-700">{l.text}</span>
              </button>))}
          </div>
        </Card>
        <Card>
          <CardHeader title="AI report" sub="every score has evidence" />
          <div className="max-h-[480px] overflow-y-auto p-4">
            {(c.results || []).map((r: any) => (
              <div key={r.id} className="border-b border-gray-100 py-2.5 text-xs last:border-0">
                <div className="flex items-center gap-2"><span className="font-semibold text-gray-900">{r.criterionName}</span>
                  <Pill tone={r.result === "pass" ? "green" : r.result === "partial" ? "amber" : "red"}>{r.result} {r.score}</Pill></div>
                <button className="mt-1 flex items-start gap-1 text-left text-indigo-700 hover:underline" onClick={() => seek(r.evidenceStart)}>
                  <Play className="mt-0.5 h-3 w-3 shrink-0" />“{r.evidenceQuote}” @{r.evidenceStart?.toFixed?.(1)}s
                </button>
              </div>))}
            {!c.results?.length && <p className="text-xs text-gray-500">Analysis pending… status: {c.status}</p>}
          </div>
        </Card>
      </div>
    </div>
  );
}

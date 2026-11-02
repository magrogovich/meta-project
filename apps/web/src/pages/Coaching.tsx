import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import { useState } from "react";
import { Link } from "wouter";
import { FileText, Mic, Check, Trash2 } from "lucide-react";
import { Card, CardHeader, Pill, scoreTone, EmptyState } from "../components/ui";
import { CoachDialog } from "./Employee";

const TABS = ["Queue", "Memos", "AI sessions", "Action items"] as const;

export function Coaching() {
  const [tab, setTab] = useState<(typeof TABS)[number]>("Queue");
  const [coachFor, setCoachFor] = useState<{ id: string; name: string } | null>(null);
  return (
    <div className="w-full space-y-4">
      <div>
        <h1 className="text-lg font-bold tracking-tight text-gray-900">Coaching</h1>
        <p className="text-xs text-gray-500">Who needs help, and what happened after.</p>
      </div>
      <div className="flex gap-1">
        {TABS.map((t) => (
          <button key={t} onClick={() => setTab(t)}
            className={`rounded-lg px-3 py-1.5 text-xs font-semibold ${tab === t ? "bg-gray-900 text-white" : "text-gray-500 hover:bg-gray-100"}`}>{t}</button>))}
      </div>
      {tab === "Queue" && <QueueTab onCoach={setCoachFor} />}
      {tab === "Memos" && <MemosTab />}
      {tab === "AI sessions" && <SessionsTab />}
      {tab === "Action items" && <ActionsTab />}
      {coachFor && <CoachDialog employeeId={coachFor.id} employeeName={coachFor.name} onClose={() => setCoachFor(null)} />}
    </div>
  );
}

function QueueTab({ onCoach }: { onCoach: (e: { id: string; name: string }) => void }) {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({ queryKey: ["queue"], queryFn: () => api("/api/coaching/queue") });
  const genMemo = useMutation({
    mutationFn: (employeeId: string) => api("/api/memos/generate", { method: "POST", body: JSON.stringify({ employeeId }) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["memos"] }),
  });
  const [memoMade, setMemoMade] = useState<string | null>(null);
  if (isLoading) return <p className="text-xs text-gray-500">Loading…</p>;
  return (
    <Card>
      <CardHeader title="Needs coaching" sub={`rules: below ${data.rules.scoreBelow}, drop ≥ ${data.rules.dropPoints} pts, ≥ ${data.rules.criticalCount} critical fails`} />
      {!data.queue.length ? <div className="p-4"><EmptyState title="Queue is clear" hint="No employee currently matches the coaching rules (tune them in Settings, Phase 7)." /></div> : (
        <ul className="divide-y divide-gray-100">
          {data.queue.map((q: any) => (
            <li key={q.employeeId} className="flex flex-wrap items-center gap-3 px-4 py-3">
              <Link href={`/employees/${q.employeeId}`} className="min-w-40 flex-1 text-xs font-semibold text-gray-900 hover:underline">{q.name} <span className="font-normal text-gray-400">· {q.department}</span></Link>
              <Pill tone={scoreTone(q.score)}>{q.score}</Pill>
              <span className="w-full text-xs text-gray-500 sm:w-auto">{q.reasons.join(" · ")}</span>
              <span className="ml-auto flex gap-2">
                <button className="btn-outline" onClick={async () => { await genMemo.mutateAsync(q.employeeId); setMemoMade(q.name); setTimeout(() => setMemoMade(null), 3000); }}>
                  <FileText className="h-3.5 w-3.5" /> Memo
                </button>
                <button className="btn" onClick={() => onCoach({ id: q.employeeId, name: q.name })}><Mic className="h-3.5 w-3.5" /> Start session</button>
              </span>
            </li>))}
        </ul>)}
      {memoMade && <p className="border-t border-gray-100 px-4 py-2 text-xs text-emerald-700">Memo generated for {memoMade} — see the Memos tab.</p>}
    </Card>
  );
}

function MemosTab() {
  const { data } = useQuery({ queryKey: ["memos"], queryFn: () => api("/api/memos") });
  const list: any[] = data || [];
  return (
    <Card>
      <CardHeader title="Memos" sub={`${list.length} total`} />
      {!list.length ? <div className="p-4"><EmptyState title="No memos yet" hint="Generate one from the queue or an employee's Coaching tab." /></div> : (
        <ul className="divide-y divide-gray-100">
          {list.map((m: any) => (
            <li key={m.id} className="px-4 py-3 text-xs">
              <div className="flex items-center gap-2">
                <Link href={`/employees/${m.employeeId}`} className="font-semibold text-gray-900 hover:underline">{m.content?.employee}</Link>
                <Pill tone="gray">{m.content?.period}</Pill>
                <Pill tone="gray">{m.content?.callCount ?? 0} calls</Pill>
                <span className="ml-auto text-gray-400">{new Date(m.createdAt).toLocaleDateString()}</span>
              </div>
              <p className="mt-1 text-gray-600">{m.content?.summary}</p>
            </li>))}
        </ul>)}
    </Card>
  );
}

function SessionsTab() {
  const { data } = useQuery({ queryKey: ["sessions"], queryFn: () => api("/api/coaching/sessions") });
  const { data: emps } = useQuery({ queryKey: ["emps"], queryFn: () => api("/api/employees") });
  const name = (id: string) => ((emps as any[]) || []).find((e) => e.id === id)?.name || "—";
  const list: any[] = data || [];
  return (
    <Card>
      <CardHeader title="AI sessions" sub={`${list.length} total`} />
      {!list.length ? <div className="p-4"><EmptyState title="No sessions yet" hint="Start one from the queue or an employee profile." /></div> : (
        <ul className="divide-y divide-gray-100">
          {list.map((x: any) => (
            <li key={x.id} className="px-4 py-3 text-xs">
              <div className="flex items-center gap-2">
                <Link href={`/employees/${x.employeeId}`} className="font-semibold text-gray-900 hover:underline">{name(x.employeeId)}</Link>
                {x.humanFlag && <Pill tone="amber">human requested</Pill>}
                <span className="ml-auto text-gray-400">{new Date(x.createdAt).toLocaleString()}</span>
              </div>
              <p className="mt-0.5 text-gray-500">Topics: {x.topics || "—"}</p>
              <p className="text-gray-500">{x.summary || ""} · {x.transport || "meet"} · {x.status || ""}{x.meetUrl ? ` · ${x.meetUrl}` : ""}</p>
              {!!(x.actionItems || []).length && <p className="text-gray-500">Agreed: {(x.actionItems as string[]).join(" · ")}</p>}
              <Link href={`/coach-room/${x.id}?token=${x.token}`} className="font-semibold text-indigo-700 hover:underline">Open coaching room →</Link>
              {" · "}<Link href={`/coach/${x.id}?token=${x.token}`} className="text-gray-500 hover:underline">browser mode</Link>
            </li>))}
        </ul>)}
    </Card>
  );
}

function ActionsTab() {
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ["actions"], queryFn: () => api("/api/coaching/actions") });
  const { data: emps } = useQuery({ queryKey: ["emps"], queryFn: () => api("/api/employees") });
  const name = (id: string) => ((emps as any[]) || []).find((e) => e.id === id)?.name || "—";
  const inv = () => qc.invalidateQueries({ queryKey: ["actions"] });
  const toggle = useMutation({ mutationFn: (a: any) => api(`/api/coaching/actions/${a.id}`, { method: "PATCH", body: JSON.stringify({ status: a.status === "done" ? "open" : "done" }) }), onSuccess: inv });
  const del = useMutation({ mutationFn: (id: string) => api(`/api/coaching/actions/${id}`, { method: "DELETE" }), onSuccess: inv });
  const list: any[] = data || [];
  const open = list.filter((a) => a.status !== "done").length;
  return (
    <Card>
      <CardHeader title="Action items" sub={`${open} open · ${list.length - open} done`} />
      {!list.length ? <div className="p-4"><EmptyState title="No action items" hint="They are created from coaching sessions and memos." /></div> : (
        <ul className="divide-y divide-gray-100">
          {list.map((a: any) => (
            <li key={a.id} className="flex items-center gap-2 px-4 py-2.5 text-xs">
              <button onClick={() => toggle.mutate(a)} className={`grid h-5 w-5 place-items-center rounded border ${a.status === "done" ? "border-gray-900 bg-gray-900 text-white" : "border-gray-300"}`}>
                {a.status === "done" && <Check className="h-3 w-3" />}
              </button>
              <Link href={`/employees/${a.employeeId}`} className="font-semibold text-gray-900 hover:underline">{name(a.employeeId)}</Link>
              <span className={`flex-1 ${a.status === "done" ? "text-gray-400 line-through" : "text-gray-700"}`}>{a.text}</span>
              <Pill tone="gray">{a.source}</Pill>
              <button className="text-gray-400 hover:text-red-600" onClick={() => del.mutate(a.id)}><Trash2 className="h-3.5 w-3.5" /></button>
            </li>))}
        </ul>)}
    </Card>
  );
}

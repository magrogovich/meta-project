import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "../lib/api";
import { Link } from "wouter";

export function Scorecard() {
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ["sc"], queryFn: () => api("/api/scorecards") });
  const [text, setText] = useState("Agents must greet with name, show empathy, verify identity, resolve with next steps, and close politely.");
  const [draft, setDraft] = useState<any[]>([]);
  const gen = useMutation({ mutationFn: () => api("/api/scorecards/generate", { method: "POST", body: JSON.stringify({ text }) }), onSuccess: (r) => setDraft(r.criteria) });
  const save = useMutation({ mutationFn: () => api("/api/scorecards", { method: "POST", body: JSON.stringify({ criteria: draft, sourceText: text }) }), onSuccess: () => { qc.invalidateQueries({ queryKey: ["sc"] }); setDraft([]); } });
  const cur = data?.[0];
  return (
    <div className="p-6 max-w-4xl mx-auto">
      <Link href="/" className="text-sm underline">← Employees</Link>
      <h1 className="text-2xl font-bold mt-1">QA Policy / Scorecard {cur ? `(v${cur.version})` : ""}</h1>
      <div className="card p-4 mt-3">
        <p className="text-sm font-semibold">Upload or paste policy</p>
        <textarea className="input mt-2 h-28" value={text} onChange={(e) => setText(e.target.value)} />
        <input className="mt-2 text-sm" type="file" accept=".pdf,.docx,.txt" onChange={async (e) => { const f = e.target.files?.[0]; if (f) setText(await f.text().catch(() => "")); }} />
        <button className="btn mt-2" onClick={() => gen.mutate()}>Convert with AI</button>
        {gen.data?.note && <p className="text-xs text-slate-500 mt-1">{gen.data.note}</p>}
      </div>
      {!!draft.length && (
        <div className="card p-4 mt-3">
          <p className="font-semibold text-sm">Review & edit criteria (weights should sum to 100)</p>
          {draft.map((c: any, i: number) => (
            <div key={i} className="grid grid-cols-6 gap-2 mt-2 text-sm">
              <input className="input col-span-2" value={c.name} onChange={(e) => setDraft(draft.map((d, j) => (j === i ? { ...d, name: e.target.value } : d)))} />
              <input className="input col-span-2" value={c.description} onChange={(e) => setDraft(draft.map((d, j) => (j === i ? { ...d, description: e.target.value } : d)))} />
              <input className="input" type="number" value={c.weight} onChange={(e) => setDraft(draft.map((d, j) => (j === i ? { ...d, weight: Number(e.target.value) } : d)))} />
              <input className="input" value={c.guidance} onChange={(e) => setDraft(draft.map((d, j) => (j === i ? { ...d, guidance: e.target.value } : d)))} />
            </div>))}
          <button className="btn mt-3" onClick={() => save.mutate()}>Save as new version</button>
        </div>)}
      {cur && <div className="card p-4 mt-3 text-sm">{cur.criteria.map((c: any) => <div key={c.id} className="border-b py-1"><b>{c.name}</b> ({c.weight}) — {c.description} <i>{c.guidance}</i></div>)}</div>}
    </div>
  );
}

export function Coach() {
  const id = location.pathname.split("/")[2];
  const token = new URLSearchParams(location.search).get("token") || "";
  const [msgs, setMsgs] = useState<{ role: string; text: string }[]>([{ role: "coach", text: "Hi! I am Arrow, your AI coach. This session is recorded and summarized. How did your recent calls feel?" }]);
  const [input, setInput] = useState("");
  const [listening, setListening] = useState(false);
  const [human, setHuman] = useState(false);
  const [mock, setMock] = useState(false);
  const speak = (t: string) => { try { speechSynthesis.cancel(); speechSynthesis.speak(new SpeechSynthesisUtterance(t)); } catch {} };
  const send = async (text: string) => {
    if (!text.trim()) return;
    setMsgs((m) => [...m, { role: "employee", text }]);
    setInput("");
    const r = await fetch(`/api/coach/${id}/chat`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ message: text, token }) }).then((x) => x.json());
    setMsgs((m) => [...m, { role: "coach", text: r.reply }]);
    setMock(r.mock); if (r.humanFlag) setHuman(true);
    speak(r.reply);
  };
  const stt = () => {
    const SR: any = (window as any).webkitSpeechRecognition || (window as any).SpeechRecognition;
    if (!SR) { alert("Speech recognition not supported — type instead."); return; }
    const rec = new SR(); rec.lang = "en-US"; setListening(true);
    rec.onresult = (e: any) => { send(e.results[0][0].transcript); setListening(false); };
    rec.onend = () => setListening(false);
    rec.start();
  };
  return (
    <div className="p-6 max-w-2xl mx-auto">
      <h1 className="text-xl font-bold">AI Coaching Session {mock && <span className="badge bg-amber-100">(mock Muse — no API key)</span>}</h1>
      <p className="text-xs text-slate-500">English only for now (config COACH_LANG for future). AI coach, recorded & summarized.</p>
      <div className="card p-4 mt-3 space-y-2 min-h-64">
        <div className="flex items-center gap-2"><div className="w-10 h-10 rounded-full bg-cyan-600 animate-pulse grid place-items-center text-white font-bold">A</div><span className="text-sm">Arrow is {listening ? "listening…" : "here"}</span></div>
        {msgs.map((m, i) => <div key={i} className={`text-sm p-2 rounded ${m.role === "coach" ? "bg-cyan-50" : "bg-slate-100 text-right"}`}><b>{m.role}:</b> {m.text}</div>)}
      </div>
      <div className="flex gap-2 mt-3">
        <input className="input" value={input} onChange={(e) => setInput(e.target.value)} onKeyDown={(e) => e.key === "Enter" && send(input)} placeholder="Type or use mic…" />
        <button className="btn-ghost" onClick={stt}>{listening ? "…" : "🎤"}</button>
        <button className="btn" onClick={() => send(input)}>Send</button>
      </div>
      <button className="btn-ghost mt-2 text-sm" onClick={async () => { await fetch(`/api/coach/${id}/flag`, { method: "POST" }); setHuman(true); }}>Request human evaluator</button>
      {human && <p className="text-sm text-amber-700 mt-1">Flagged for a human evaluator. They will follow up.</p>}
    </div>
  );
}

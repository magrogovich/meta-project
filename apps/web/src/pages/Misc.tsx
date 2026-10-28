import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "../lib/api";
import { Link } from "wouter";
import { ArrowLeft, Wand2, Save, Mic, Hand } from "lucide-react";
import { Card, CardHeader, Pill } from "../components/ui";

export function Scorecard() {
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ["sc"], queryFn: () => api("/api/scorecards") });
  const [text, setText] = useState("Agents must greet with name, show empathy, verify identity, resolve with next steps, and close politely.");
  const [draft, setDraft] = useState<any[]>([]);
  const gen = useMutation({ mutationFn: () => api("/api/scorecards/generate", { method: "POST", body: JSON.stringify({ text }) }), onSuccess: (r) => setDraft(r.criteria) });
  const save = useMutation({ mutationFn: () => api("/api/scorecards", { method: "POST", body: JSON.stringify({ criteria: draft, sourceText: text }) }), onSuccess: () => { qc.invalidateQueries({ queryKey: ["sc"] }); setDraft([]); } });
  const cur = data?.[0];
  return (
    <div className="mx-auto w-full max-w-4xl space-y-4">
      <Link href="/" className="inline-flex items-center gap-1 text-xs font-medium text-gray-500 hover:text-gray-900"><ArrowLeft className="h-3.5 w-3.5" /> Dashboard</Link>
      <div>
        <h1 className="text-lg font-bold tracking-tight text-gray-900">QA Policy / Scorecard {cur ? <Pill tone="gray">v{cur.version}</Pill> : ""}</h1>
        <p className="text-xs text-gray-500">Paste the policy, convert with AI, review, save as a new version. Calls keep the version that scored them.</p>
      </div>
      <Card className="p-4">
        <p className="text-xs font-semibold text-gray-900">Policy text</p>
        <textarea className="input mt-2 h-28" value={text} onChange={(e) => setText(e.target.value)} />
        <div className="mt-2 flex items-center gap-2">
          <input className="text-xs text-gray-500" type="file" accept=".pdf,.docx,.txt" onChange={async (e) => { const f = e.target.files?.[0]; if (f) setText(await f.text().catch(() => "")); }} />
          <button className="btn ml-auto" onClick={() => gen.mutate()}><Wand2 className="h-3.5 w-3.5" /> Convert with AI</button>
        </div>
        {gen.data?.note && <p className="mt-1 text-[11px] text-gray-400">{gen.data.note}</p>}
      </Card>
      {!!draft.length && (
        <Card className="p-4">
          <p className="text-xs font-semibold text-gray-900">Review criteria (weights should sum to 100)</p>
          <div className="mt-2 space-y-2">
            {draft.map((c: any, i: number) => (
              <div key={i} className="grid grid-cols-12 gap-2">
                <input className="input col-span-3" value={c.name} onChange={(e) => setDraft(draft.map((d, j) => (j === i ? { ...d, name: e.target.value } : d)))} />
                <input className="input col-span-5" value={c.description} onChange={(e) => setDraft(draft.map((d, j) => (j === i ? { ...d, description: e.target.value } : d)))} />
                <input className="input col-span-1" type="number" value={c.weight} onChange={(e) => setDraft(draft.map((d, j) => (j === i ? { ...d, weight: Number(e.target.value) } : d)))} />
                <input className="input col-span-3" value={c.guidance} onChange={(e) => setDraft(draft.map((d, j) => (j === i ? { ...d, guidance: e.target.value } : d)))} />
              </div>))}
          </div>
          <button className="btn mt-3" onClick={() => save.mutate()}><Save className="h-3.5 w-3.5" /> Save as new version</button>
        </Card>)}
      {cur && (
        <Card>
          <CardHeader title={`Active scorecard v${cur.version}`} sub={`${cur.criteria.length} criteria`} />
          <ul className="divide-y divide-gray-100">
            {cur.criteria.map((c: any) => (
              <li key={c.id} className="px-4 py-2.5 text-xs">
                <span className="font-semibold text-gray-900">{c.name}</span> <Pill tone="gray">{c.weight}</Pill>
                <span className="text-gray-500"> — {c.description} <i>{c.guidance}</i></span>
              </li>))}
          </ul>
        </Card>)}
    </div>
  );
}

export function Coach() {
  const id = location.pathname.split("/")[2];
  const token = new URLSearchParams(location.search).get("token") || "";
  const [msgs, setMsgs] = useState<{ role: string; text: string }[]>([{ role: "coach", text: "Hi! I am Aro, your AI coach. This session is recorded and summarized. How did your recent calls feel?" }]);
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
    <div className="mx-auto w-full max-w-2xl space-y-3">
      <div className="flex items-center gap-2">
        <h1 className="text-lg font-bold tracking-tight text-gray-900">AI coaching session</h1>
        {mock && <Pill tone="amber">mock Aro — no API key</Pill>}
      </div>
      <p className="text-xs text-gray-500">English only for now. AI coach, recorded &amp; summarized. Safety: the coach never makes employment decisions.</p>
      <Card className="p-4">
        <div className="mb-3 flex items-center gap-2">
          <div className="grid h-10 w-10 animate-pulse place-items-center rounded-full bg-gray-900 font-bold text-white">A</div>
          <span className="text-xs text-gray-500">Aro is {listening ? "listening…" : "here"}</span>
        </div>
        <div className="max-h-80 space-y-2 overflow-y-auto">
          {msgs.map((m, i) => (
            <div key={i} className={`rounded-lg p-2.5 text-xs ${m.role === "coach" ? "bg-gray-50 text-gray-800" : "bg-gray-900 text-white"}`}>
              <span className="font-semibold">{m.role === "coach" ? "Aro" : "You"}: </span>{m.text}
            </div>))}
        </div>
        <div className="mt-3 flex gap-2">
          <input className="input" value={input} onChange={(e) => setInput(e.target.value)} onKeyDown={(e) => e.key === "Enter" && send(input)} placeholder="Type or use mic…" />
          <button className="btn-outline" onClick={stt} title="Voice input"><Mic className="h-4 w-4" /></button>
          <button className="btn" onClick={() => send(input)}>Send</button>
        </div>
        <button className="btn-outline mt-2" onClick={async () => { await fetch(`/api/coach/${id}/flag`, { method: "POST" }); setHuman(true); }}>
          <Hand className="h-3.5 w-3.5" /> Request human evaluator
        </button>
        {human && <p className="mt-1 text-xs text-amber-700">Flagged for a human evaluator. They will follow up.</p>}
      </Card>
    </div>
  );
}

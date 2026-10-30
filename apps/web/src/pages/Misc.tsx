import { useState } from "react";
import { api } from "../lib/api";
import { Mic, Hand } from "lucide-react";
import { Card, Pill } from "../components/ui";
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
    <div className="w-full max-w-4xl space-y-3">
      <div className="flex items-center gap-2">
        <h1 className="text-lg font-bold tracking-tight text-gray-900">AI coaching session</h1>
        {mock && <Pill tone="amber">mock Aro — no API key</Pill>}
      </div>
      <p className="text-xs text-gray-500">English only for now. AI coach, recorded &amp; summarized. Safety: the coach never makes employment decisions.</p>
      <Card className="p-4">
        <div className="mb-3 flex items-center gap-2">
          <div className="grid h-10 w-10 place-items-center overflow-hidden rounded-full"><img src="/icon.png" alt="Aro" className="h-10 w-10 animate-pulse object-cover" /></div>
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

import { useState } from "react";
import { api } from "../lib/api";
import { useLocation } from "wouter";

export function Login() {
  const [, nav] = useLocation();
  const [mode, setMode] = useState<"login" | "signup">("login");
  const [email, setEmail] = useState("demo@arrowfield.ai");
  const [password, setPassword] = useState("demo1234");
  const [err, setErr] = useState("");
  const go = async (fn: () => Promise<any>) => {
    setErr("");
    try { const r = await fn(); localStorage.setItem("token", r.token); nav("/"); }
    catch (e: any) { setErr(e.message); }
  };
  return (
    <div className="min-h-screen grid place-items-center p-6">
      <div className="card p-8 w-full max-w-md">
        <h1 className="text-2xl font-bold text-cyan-800">Arrowfield Calls</h1>
        <p className="text-sm text-slate-500 mt-1">AI QA for 100% of calls. AI assists, humans decide — no automated disciplinary actions.</p>
        <div className="flex gap-2 mt-4">
          <button className={mode === "login" ? "btn" : "btn-ghost"} onClick={() => setMode("login")}>Login</button>
          <button className={mode === "signup" ? "btn" : "btn-ghost"} onClick={() => setMode("signup")}>Signup</button>
        </div>
        <input className="input mt-4" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="email" />
        <input className="input mt-2" type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="password" />
        {err && <p className="text-rose-600 text-sm mt-2">{err}</p>}
        <button className="btn w-full mt-4" onClick={() => go(() => api(mode === "login" ? "/api/auth/login" : "/api/auth/signup", { method: "POST", body: JSON.stringify({ email, password }) }))}>
          {mode === "login" ? "Log in" : "Sign up (creates Organization)"}
        </button>
        <button className="btn-ghost w-full mt-2" onClick={() => go(() => api("/api/auth/google", { method: "POST", body: JSON.stringify({ email, name: email.split("@")[0] }) }))}>
          Continue with Google {(import.meta as any).env?.VITE_API_URL === undefined ? "(mock if no client ID)" : ""}
        </button>
      </div>
    </div>
  );
}

export function Walkthrough({ open, onClose }: { open: boolean; onClose: () => void }) {
  if (!open) return null;
  const steps = ["1. Upload or paste the QA policy (Scorecard page)", "2. Add the first employee (Employees page)", "3. Copy the session key shown once at creation", "4. Install the desktop agent (agent/README) and paste the key", "5. See the first call appear on the employee profile"];
  return (
    <div className="fixed inset-0 bg-black/30 grid place-items-center p-4 z-50">
      <div className="card p-6 max-w-lg w-full">
        <h2 className="font-bold text-lg">Getting started</h2>
        <ol className="list-decimal ml-5 mt-2 space-y-1 text-sm">{steps.map((s) => <li key={s}>{s}</li>)}</ol>
        <button className="btn mt-4" onClick={onClose}>Got it (skippable, re-open via Help)</button>
      </div>
    </div>
  );
}

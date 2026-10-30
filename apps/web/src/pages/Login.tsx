import { useEffect, useState } from "react";
import { api, API } from "../lib/api";
import { useAuth } from "../lib/auth";
import { useLocation } from "wouter";

function GoogleLogo() {
  return (
    <svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true">
      <path fill="#FFC107" d="M43.8 20.1H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.9 1.2 8 3l5.7-5.7C34.5 6.1 29.5 4 24 4 13 4 4 13 4 24s9 20 20 20 20-9 20-20c0-1.3-.1-2.6-.2-3.9z" />
      <path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.9 1.2 8 3l5.7-5.7C34.5 6.1 29.5 4 24 4 16.3 4 9.7 8.3 6.3 14.7z" />
      <path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-8l-6.5 5C9.5 39.6 16.2 44 24 44z" />
      <path fill="#1976D2" d="M43.8 20.1H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C36.9 39.2 44 34 44 24c0-1.3-.1-2.6-.2-3.9z" />
    </svg>
  );
}

export function Login() {
  const [, nav] = useLocation();
  const { login } = useAuth();
  const [mode, setMode] = useState<"login" | "signup">("login");
  const [email, setEmail] = useState("demo@arocall.ai");
  const [password, setPassword] = useState("demo1234");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [googleId, setGoogleId] = useState<string | null>(null);
  useEffect(() => {
    api("/api/auth/config").then((c) => setGoogleId(c.googleClientId)).catch(() => setGoogleId(null));
  }, []);
  useEffect(() => {
    if (!googleId) return;
    const renderBtn = () => {
      const g = (window as any).google;
      if (!g?.accounts?.id) return;
      g.accounts.id.initialize({
        client_id: googleId,
        callback: (resp: any) => go(() => api("/api/auth/google", { method: "POST", body: JSON.stringify({ credential: resp.credential }) })),
      });
      const el = document.getElementById("gis-btn");
      if (!el) return;
      const w = Math.max(200, Math.min(400, Math.floor(el.clientWidth || 320)));
      g.accounts.id.renderButton(el, { theme: "outline", size: "large", width: w, text: "continue_with", shape: "rectangular", logo_alignment: "left" });
    };
    if ((window as any).google?.accounts?.id) { renderBtn(); return; }
    const s = document.createElement("script");
    s.src = "https://accounts.google.com/gsi/client";
    s.async = true; s.defer = true; s.onload = renderBtn;
    document.head.appendChild(s);
  }, [googleId]);
  const go = async (fn: () => Promise<any>) => {
    setErr(""); setBusy(true);
    try { const r = await fn(); login(r.token); nav("/"); }
    catch (e: any) {
      const msg = String(e.message || "request failed");
      setErr(/failed to fetch|networkerror|load failed/i.test(msg)
        ? `Cannot reach the API (${API || "same origin"}/api). Start it with: pnpm --filter @arocall/api dev`
        : msg);
    }
    finally { setBusy(false); }
  };
  return (
    <div className="font-sans-dashboard grid min-h-[100dvh] place-items-center bg-gray-50 p-6 text-[13px]">
      <div className="card w-full max-w-md p-8">
        <div className="flex items-center gap-2.5">
          <div className="flex h-9 w-9 items-center justify-center overflow-hidden rounded-lg"><img src="/icon.png" alt="Arocall" className="h-9 w-9 object-cover" /></div>
          <h1 className="text-lg font-bold tracking-tight text-gray-900">Arocall</h1>
        </div>
        <p className="mt-1 text-xs text-gray-500">AI QA for 100% of calls. AI assists, humans decide — no automated disciplinary actions.</p>
        <div className="mt-4 flex gap-2">
          <button className={mode === "login" ? "btn flex-1" : "btn-outline flex-1"} onClick={() => setMode("login")}>Login</button>
          <button className={mode === "signup" ? "btn flex-1" : "btn-outline flex-1"} onClick={() => setMode("signup")}>Signup</button>
        </div>
        <label className="mt-4 block text-[11px] font-semibold text-gray-500">Email</label>
        <input className="input mt-1" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="email" />
        <label className="mt-2 block text-[11px] font-semibold text-gray-500">Password</label>
        <input className="input mt-1" type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="password" />
        {err && <p className="mt-2 rounded-md bg-red-50 p-2 text-xs text-red-600 ring-1 ring-red-200">{err}</p>}
        <button className="btn mt-4 w-full" disabled={busy} onClick={() => go(() => api(mode === "login" ? "/api/auth/login" : "/api/auth/signup", { method: "POST", body: JSON.stringify({ email, password }) }))}>
          {busy ? "Please wait…" : mode === "login" ? "Log in" : "Sign up (creates Organization)"}
        </button>
        {googleId ? (
          <div className="gis-wrap mt-2 w-full"><div id="gis-btn" className="w-full" /></div>
        ) : (
          <button className="btn-outline mt-2 w-full disabled:opacity-60" disabled={busy} onClick={() => go(() => api("/api/auth/google", { method: "POST", body: JSON.stringify({ email, name: email.split("@")[0] }) }))}>
            <GoogleLogo /> Continue with Google
          </button>
        )}
        <p className="mt-2 text-center text-[11px] text-gray-400">{googleId ? "Verified with Google." : "Google login is mock mode until GOOGLE_CLIENT_ID is set on the API."}</p>
      </div>
    </div>
  );
}

export function Walkthrough({ open, onClose }: { open: boolean; onClose: () => void }) {
  if (!open) return null;
  const steps = [
    "Add the company guidelines (Guidelines page): upload a Markdown file, write your own, or use the starter template — then Activate it and approve the generated evaluation criteria",
    "Add the first employee (Employees page): the wizard collects details, then shows the persistent session key for the desktop agent",
    "Install the desktop agent (agent/README) and paste the key (reveal it again anytime from the employee's Agent tab)",
    "Make a test call — it appears analyzed on the Dashboard and the employee profile",
    "When scores slip, open Coaching: work the queue, generate a memo, or start an AI session",
  ];
  return (
    <div className="fixed inset-0 z-[100] grid place-items-center bg-black/40 p-4">
      <div className="card w-full max-w-lg p-6">
        <h2 className="text-sm font-bold text-gray-900">Getting started</h2>
        <ol className="ml-5 mt-2 list-decimal space-y-1 text-xs text-gray-600">{steps.map((s) => <li key={s}>{s}</li>)}</ol>
        <button className="btn mt-4" onClick={onClose}>Got it (skippable, re-open via Help)</button>
      </div>
    </div>
  );
}

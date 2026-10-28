export const API = (import.meta as any).env?.VITE_API_URL || "";
export const api = async (path: string, opts: any = {}) => {
  const token = localStorage.getItem("token");
  const res = await fetch(API + path, { ...opts, headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(opts.headers || {}) } });
  if (!res.ok) throw new Error((await res.json().catch(() => ({ error: res.statusText }))).error || "request failed");
  return res.json();
};
export const authHeader = () => ({ Authorization: `Bearer ${localStorage.getItem("token")}` });
export const scoreColor = (s: number) => (s >= 80 ? "bg-emerald-100 text-emerald-800" : s >= 60 ? "bg-amber-100 text-amber-800" : "bg-rose-100 text-rose-800");

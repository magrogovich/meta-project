import { createContext, useContext, useState, type ReactNode } from "react";

type Auth = { token: string | null; role: string | null; login: (t: string) => void; logout: () => void };
const Ctx = createContext<Auth>({ token: null, role: null, login: () => {}, logout: () => {} });
export const useAuth = () => useContext(Ctx);

const roleOf = (t: string | null) => {
  try { return t ? (JSON.parse(atob(t.split(".")[1])) as any).role || null : null; }
  catch { return null; }
};

export function AuthProvider({ children }: { children: ReactNode }) {
  const [token, setToken] = useState<string | null>(() => localStorage.getItem("token"));
  const login = (t: string) => { localStorage.setItem("token", t); setToken(t); };
  const logout = () => { localStorage.removeItem("token"); setToken(null); };
  return <Ctx.Provider value={{ token, role: roleOf(token), login, logout }}>{children}</Ctx.Provider>;
}

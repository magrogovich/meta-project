import { createContext, useContext, useState, type ReactNode } from "react";

type Auth = { token: string | null; login: (t: string) => void; logout: () => void };
const Ctx = createContext<Auth>({ token: null, login: () => {}, logout: () => {} });
export const useAuth = () => useContext(Ctx);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [token, setToken] = useState<string | null>(() => localStorage.getItem("token"));
  const login = (t: string) => { localStorage.setItem("token", t); setToken(t); };
  const logout = () => { localStorage.removeItem("token"); setToken(null); };
  return <Ctx.Provider value={{ token, login, logout }}>{children}</Ctx.Provider>;
}

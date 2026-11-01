import { useState, type ReactNode } from "react";
import { Link, useLocation } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { LayoutDashboard, PhoneCall, Users, Mic, BookOpen, Settings as SettingsIcon, Bell, Menu, LogOut, CircleHelp } from "lucide-react";
import { api } from "../lib/api";
import { useAuth } from "../lib/auth";

const NAV = [
  { icon: LayoutDashboard, label: "Dashboard", path: "/" },
  { icon: PhoneCall, label: "Calls", path: "/calls" },
  { icon: Users, label: "Employees", path: "/employees" },
  { icon: Mic, label: "Coaching", path: "/coaching" },
  { icon: BookOpen, label: "Guidelines", path: "/guidelines" },
] as const;
const NAV_BOTTOM = [
  { icon: SettingsIcon, label: "Settings", path: "/settings" },
] as const;

function pageNameFor(path: string): string {
  const p = path.split("?")[0];
  if (p === "/") return "Dashboard";
  if (p.startsWith("/calls") && p !== "/calls") return "Call detail";
  if (p.startsWith("/calls")) return "Calls";
  if (p.startsWith("/employees") && p !== "/employees") return "Employee profile";
  if (p.startsWith("/employees")) return "Employees";
  if (p.startsWith("/coaching")) return "Coaching";
  if (p.startsWith("/guidelines")) return "Guidelines";
  if (p.startsWith("/settings")) return "Settings";
  if (p.startsWith("/coach")) return "AI coaching";
  return "Workspace";
}

function Sidebar({ onNav }: { onNav: () => void }) {
  const [location] = useLocation();
  const { logout } = useAuth();
  const [, nav] = useLocation();
  const routePath = location.split("?")[0] || "/";
  return (
    <aside className="relative z-10 flex h-full w-52 flex-shrink-0 flex-col border-e border-gray-200 bg-white">
      <div className="flex h-14 items-center px-4">
        <Link href="/" onClick={onNav} className="flex min-w-0 cursor-pointer items-center gap-2.5">
          <div className="flex h-8 w-8 shrink-0 items-center justify-center overflow-hidden rounded-lg"><img src="/icon.png" alt="Arocall" className="h-8 w-8 object-cover" /></div>
          <span className="truncate text-sm font-bold tracking-tight text-gray-900">Arocall</span>
        </Link>
      </div>
      <div className="flex-1 space-y-1 overflow-y-auto px-3 py-4">
        <div className="mb-3 px-2 text-[10px] font-semibold uppercase tracking-wider text-gray-400">Main menu</div>
        {NAV.map((item) => {
          const isActive = item.path === "/" ? routePath === "/" : routePath.startsWith(item.path);
          return (
            <Link
              key={item.path}
              href={item.path}
              onClick={onNav}
              className={`group flex w-full cursor-pointer items-center rounded-lg px-2.5 py-2 transition-all duration-150 ${
                isActive ? "bg-gray-900 text-white" : "text-gray-500 hover:bg-gray-50 hover:text-gray-900"
              }`}
            >
              <div className="flex items-center gap-3">
                <item.icon className={`h-4 w-4 ${isActive ? "text-white" : "text-gray-400 group-hover:text-gray-600"}`} />
                <span className="text-xs font-medium">{item.label}</span>
              </div>
            </Link>
          );
        })}
      </div>
      <div className="space-y-2 p-3">
        {NAV_BOTTOM.map((item) => {
          const isActive = routePath.startsWith(item.path);
          return (
            <Link key={item.path} href={item.path} onClick={onNav}
              className={`group flex w-full cursor-pointer items-center rounded-lg px-2.5 py-2 transition-all duration-150 ${isActive ? "bg-gray-900 text-white" : "text-gray-500 hover:bg-gray-50 hover:text-gray-900"}`}>
              <div className="flex items-center gap-3">
                <item.icon className={`h-4 w-4 ${isActive ? "text-white" : "text-gray-400 group-hover:text-gray-600"}`} />
                <span className="text-xs font-medium">{item.label}</span>
              </div>
            </Link>
          );
        })}
        <button type="button" onClick={() => { onHelp(); onNav(); }}
          className="group flex w-full cursor-pointer items-center rounded-lg px-2.5 py-2 text-gray-500 transition-all duration-150 hover:bg-gray-50 hover:text-gray-900">
          <div className="flex items-center gap-3">
            <CircleHelp className="h-4 w-4 text-gray-400 group-hover:text-gray-600" />
            <span className="text-xs font-medium">Help</span>
          </div>
        </button>
        <div className="group flex items-center gap-2.5 rounded-lg p-2">
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-gray-200 bg-gray-100 text-xs font-semibold text-gray-700">A</div>
          <div className="min-w-0 flex-1">
            <div className="truncate text-xs font-semibold text-gray-900">Evaluator</div>
            <div className="truncate text-xs text-gray-500">AI assists, humans decide</div>
          </div>
          <button
            type="button"
            title="Sign out"
            onClick={() => { logout(); nav("/login"); onNav(); }}
            className="shrink-0 rounded-md p-1.5 text-gray-400 transition-opacity hover:bg-gray-200 hover:text-gray-900"
          >
            <LogOut className="h-4 w-4" />
          </button>
        </div>
      </div>
    </aside>
  );
}

function Notifications() {
  const [open, setOpen] = useState(false);
  const { data } = useQuery({ queryKey: ["calls"], queryFn: () => api("/api/calls"), staleTime: 30_000 });
  const lows = ((data as any[]) || []).filter((c) => c.status === "done" && c.score < 60).slice(0, 5);
  return (
    <div className="relative">
      <button type="button" onClick={() => setOpen((o) => !o)} aria-label="Notifications"
        className="relative rounded-md p-1.5 text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-900">
        <Bell className="h-4 w-4" />
        {lows.length > 0 && <span className="absolute end-1.5 top-1.5 h-1.5 w-1.5 rounded-full bg-gray-900 ring-2 ring-white" />}
      </button>
      {open && (
        <div className="absolute end-0 top-full z-[120] mt-2 w-[min(20rem,calc(100vw-1.5rem))] overflow-hidden rounded-lg border border-gray-200 bg-white shadow-lg">
          <div className="border-b border-gray-100 px-3 py-2 text-xs font-semibold text-gray-900">Low-score alerts</div>
          <div className="max-h-72 overflow-y-auto">
            {lows.length === 0 ? (
              <div className="px-4 py-8 text-center text-xs text-gray-500">No low scores. All clear.</div>
            ) : (
              <ul className="divide-y divide-gray-100">
                {lows.map((c: any) => (
                  <li key={c.id}>
                    <Link href={`/calls/${c.id}`} onClick={() => setOpen(false)} className="block px-3 py-2.5 hover:bg-gray-50">
                      <div className="text-xs font-medium text-gray-900">Call scored {c.score} ({c.language})</div>
                      <div className="mt-0.5 text-[11px] text-gray-500">{new Date(c.startedAt).toLocaleString()}</div>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export function AppLayout({ children, onHelp }: { children: ReactNode; onHelp: () => void }) {
  const [location] = useLocation();
  const [mobileOpen, setMobileOpen] = useState(false);
  return (
    <div className="font-sans-dashboard flex h-[100dvh] min-h-[100dvh] overflow-hidden bg-gray-50 text-[13px] text-gray-950">
      {mobileOpen && <button type="button" aria-label="Close menu" className="fixed inset-0 z-40 bg-black/40 md:hidden" onClick={() => setMobileOpen(false)} />}
      <div className={`fixed start-0 top-0 bottom-0 z-50 flex max-w-[min(100vw,13rem)] transition-transform duration-200 ease-out md:relative md:z-10 md:max-w-none md:translate-x-0 ${mobileOpen ? "translate-x-0" : "-translate-x-full"}`}>
        <Sidebar onNav={() => setMobileOpen(false)} />
      </div>
      <main className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <header className="z-10 flex h-14 flex-shrink-0 items-center justify-between border-b border-gray-200 bg-white px-3 md:px-5">
          <div className="flex min-w-0 flex-1 items-center gap-2">
            <button type="button" aria-label="Open menu" className="shrink-0 rounded-md p-1.5 text-gray-500 hover:bg-gray-100 hover:text-gray-900 md:hidden" onClick={() => setMobileOpen(true)}>
              <Menu className="h-5 w-5" />
            </button>
            <div className="flex min-w-0 items-center gap-1.5 text-xs text-gray-500">
              <Link href="/" className="shrink-0 font-medium text-gray-600 hover:text-gray-900">Workspace</Link>
              <span className="text-gray-300">/</span>
              <span className="truncate font-semibold text-gray-900">{pageNameFor(location)}</span>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            <button type="button" onClick={onHelp} title="Help / walkthrough" className="rounded-md p-1.5 text-gray-400 hover:bg-gray-100 hover:text-gray-900">
              <CircleHelp className="h-4 w-4" />
            </button>
            <Notifications />
          </div>
        </header>
        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto p-3 md:p-5">{children}</div>
      </main>
    </div>
  );
}

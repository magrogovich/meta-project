import "./index.css";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Route, Switch, Redirect } from "wouter";
import { useState } from "react";
import { AuthProvider, useAuth } from "./lib/auth";
import { AppLayout } from "./components/layout";
import { Login, Walkthrough } from "./pages/Login";
import { Dashboard } from "./pages/Dashboard";
import { EmployeeProfile, CallDetail } from "./pages/Employee";
import { Scorecard, Coach } from "./pages/Misc";
import { ComingSoon, Analytics } from "./pages/Stub";
import { Employees } from "./pages/Employees";

const qc = new QueryClient();
function Shell() {
  return <AuthProvider><App /></AuthProvider>;
}
function App() {
  const { token } = useAuth();
  const authed = !!token;
  const [help, setHelp] = useState(!localStorage.getItem("walk"));
  const helpFn = () => setHelp(true);
  return (
    <>
      <Walkthrough open={help && authed} onClose={() => { localStorage.setItem("walk", "1"); setHelp(false); }} />
      <Switch>
        <Route path="/login"><Login /></Route>
        <Route path="/coach/:id"><Coach /></Route>
        <Route>
          {authed ? (
            <AppLayout onHelp={helpFn}>
              <Switch>
                <Route path="/"><Dashboard /></Route>
                <Route path="/employees"><Employees /></Route>
                <Route path="/employees/:id"><EmployeeProfile /></Route>
                <Route path="/calls/:id"><CallDetail /></Route>
                <Route path="/calls"><ComingSoon title="Calls" hint="Global call table with filters, sorting and pagination lands in Phase 4." /></Route>
                <Route path="/coaching"><ComingSoon title="Coaching" hint="Coaching queue, memos, sessions and action items land in Phase 5." /></Route>
                <Route path="/guidelines"><ComingSoon title="Guidelines" hint="Markdown guidelines replace QA scorecards in Phase 6." /></Route>
                <Route path="/analytics"><Analytics /></Route>
                <Route path="/settings"><ComingSoon title="Settings" hint="Organization, team, departments, coaching rules and audit log land in Phase 7." /></Route>
                <Route path="/scorecard"><Scorecard /></Route>
                <Route><Redirect to="/" /></Route>
              </Switch>
            </AppLayout>
          ) : (
            <Redirect to="/login" />
          )}
        </Route>
      </Switch>
    </>
  );
}
createRoot(document.getElementById("root")!).render(<QueryClientProvider client={qc}><Shell /></QueryClientProvider>);

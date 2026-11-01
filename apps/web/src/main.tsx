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
import { Employees } from "./pages/Employees";
import { Calls } from "./pages/Calls";
import { Coaching } from "./pages/Coaching";
import { Guidelines, GuidelineDoc } from "./pages/Guidelines";
import { Settings, AcceptInvite } from "./pages/Settings";
import { Coach } from "./pages/Misc";

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
        <Route path="/accept-invite"><AcceptInvite /></Route>
        <Route path="/coach/:id"><Coach /></Route>
        <Route>
          {authed ? (
            <AppLayout onHelp={helpFn}>
              <Switch>
                <Route path="/"><Dashboard /></Route>
                <Route path="/employees"><Employees /></Route>
                <Route path="/employees/:id"><EmployeeProfile /></Route>
                <Route path="/calls/:id"><CallDetail /></Route>
                <Route path="/calls"><Calls /></Route>
                <Route path="/coaching"><Coaching /></Route>
                <Route path="/guidelines"><Guidelines /></Route>
                <Route path="/guidelines/:id"><GuidelineDoc /></Route>
                <Route path="/settings"><Settings /></Route>
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

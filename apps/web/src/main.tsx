import "./index.css";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Route, Switch, Redirect } from "wouter";
import { useState } from "react";
import { Login, Walkthrough } from "./pages/Login";
import { Dashboard } from "./pages/Dashboard";
import { EmployeeProfile, CallDetail } from "./pages/Employee";
import { Scorecard, Coach } from "./pages/Misc";

const qc = new QueryClient();
function Shell() {
  const [help, setHelp] = useState(!localStorage.getItem("walk"));
  const authed = !!localStorage.getItem("token");
  return (
    <>
      <Walkthrough open={help && authed} onClose={() => { localStorage.setItem("walk", "1"); setHelp(false); }} />
      <Switch>
        <Route path="/login"><Login /></Route>
        <Route path="/">{authed ? <Dashboard onHelp={() => setHelp(true)} /> : <Redirect to="/login" />}</Route>
        <Route path="/employees/:id">{authed ? <EmployeeProfile /> : <Redirect to="/login" />}</Route>
        <Route path="/calls/:id">{authed ? <CallDetail /> : <Redirect to="/login" />}</Route>
        <Route path="/scorecard">{authed ? <Scorecard /> : <Redirect to="/login" />}</Route>
        <Route path="/coach/:id"><Coach /></Route>
      </Switch>
    </>
  );
}
createRoot(document.getElementById("root")!).render(<QueryClientProvider client={qc}><Shell /></QueryClientProvider>);

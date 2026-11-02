// Google Meet space creation via Meet REST API (spaces.create, accessType OPEN).
// Falls back to manual link when not connected. Never logs tokens.
import { coachEnv } from "./coach.js";

export function googleOAuthUrl(orgId: string): string {
  const p = new URLSearchParams({
    client_id: coachEnv.googleClientId,
    redirect_uri: coachEnv.googleRedirect,
    response_type: "code",
    scope: "https://www.googleapis.com/auth/meetings.space.created",
    access_type: "offline",
    prompt: "consent",
    state: orgId,
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${p}`;
}

export async function exchangeCode(code: string): Promise<{ access: string; refresh: string; email: string; expiresAt: number }> {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: coachEnv.googleClientId,
      client_secret: coachEnv.googleClientSecret,
      redirect_uri: coachEnv.googleRedirect,
      grant_type: "authorization_code",
    }),
  });
  if (!res.ok) throw new Error("google token exchange failed");
  const j: any = await res.json();
  return { access: j.access_token, refresh: j.refresh_token || "", email: "", expiresAt: Date.now() + (j.expires_in || 3600) * 1000 };
}

export async function createMeetSpace(accessToken: string): Promise<{ name: string; url: string }> {
  const res = await fetch("https://meet.googleapis.com/v2/spaces", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${accessToken}` },
    body: JSON.stringify({ config: { accessType: "OPEN" } }),
  });
  if (!res.ok) throw new Error(`meet spaces.create HTTP ${res.status}`);
  const j: any = await res.json();
  return { name: j.name || "", url: j.meetingUri || j.meetingLink || "" };
}

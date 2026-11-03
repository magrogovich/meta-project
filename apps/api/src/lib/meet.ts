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

export async function refreshAccessToken(refreshToken: string): Promise<{ access: string; expiresAt: number }> {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      refresh_token: refreshToken,
      client_id: coachEnv.googleClientId,
      client_secret: coachEnv.googleClientSecret,
      grant_type: "refresh_token",
    }),
  });
  if (!res.ok) throw new Error("google token refresh failed");
  const j: any = await res.json();
  return { access: j.access_token, expiresAt: Date.now() + (j.expires_in || 3600) * 1000 };
}

// Returns a usable access token for the org, refreshing when expired.
// Throws with a human-readable message the API surfaces as meetError.
export async function orgAccessToken(db: any, s: any, orgId: string): Promise<string> {
  const { eq } = await import("drizzle-orm");
  const { decryptKey, encryptKey } = await import("./keys.js");
  const integ = (await db.select().from(s.googleIntegrations).where(eq(s.googleIntegrations.orgId, orgId)))[0] as any;
  if (!integ?.accessEnc) throw new Error("google_not_connected");
  const expired = !integ.expiresAt || Date.now() > +new Date(integ.expiresAt) - 60000;
  if (!expired) return decryptKey(integ.accessEnc);
  if (!integ.refreshEnc) throw new Error("google_token_expired");
  const t = await refreshAccessToken(decryptKey(integ.refreshEnc));
  await db.update(s.googleIntegrations).set({ accessEnc: encryptKey(t.access), expiresAt: new Date(t.expiresAt) }).where(eq(s.googleIntegrations.orgId, orgId));
  return t.access;
}

export async function createMeetSpace(accessToken: string): Promise<{ name: string; url: string }> {
  const res = await fetch("https://meet.googleapis.com/v2/spaces", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${accessToken}` },
    body: JSON.stringify({ config: { accessType: "OPEN" } }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`meet spaces.create HTTP ${res.status}: ${body.slice(0, 300)}`);
  }
  const j: any = await res.json();
  return { name: j.name || "", url: j.meetingUri || j.meetingLink || "" };
}

// Coaching invite mailer (Gmail app-password). Graceful fallback: without
// GMAIL_USER + GMAIL_APP_PASSWORD the invite is logged and the API reports
// { sent: false } so the UI can show the manual copy/email options instead of
// failing session creation.
export function mailerConfig() {
  return {
    user: process.env.GMAIL_USER || "",
    pass: process.env.GMAIL_APP_PASSWORD || "",
    from: process.env.GMAIL_NOTIFICATION_FROM || process.env.GMAIL_USER || "Arocall <no-reply@arocall.ai>",
  };
}

export const MEET_LINK_RE = /^https:\/\/meet\.google\.com\/[a-z]{3,}-[a-z]{4,}-[a-z]{3,}\/?(\?.*)?$/i;

export function isValidEmail(e: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(e || "").trim());
}

export function isValidMeetLink(u: string) {
  return MEET_LINK_RE.test(String(u || "").trim());
}

export function inviteHtml(opts: { employeeName: string; orgName: string; meetUrl: string; roomUrl: string; when: string; topics: string }) {
  const meet = opts.meetUrl
    ? `<p><a href="${opts.meetUrl}">Join the Google Meet</a> — the AI coach will already be there listening. Just talk; it hears you, thinks (Muse Spark), and answers by voice.<br>Link (copy if needed): <a href="${opts.meetUrl}">${opts.meetUrl}</a></p>`
    : `<p>The Meet link is not ready yet — open the <a href="${opts.roomUrl}">Coaching room</a> for the latest link.</p>`;
  return `<p>Hi ${opts.employeeName},</p>
<p>You have an AI coaching session${opts.when ? ` scheduled for <b>${opts.when}</b>` : ""} (${opts.orgName}).</p>
${meet}
<p>Live transcript + controls: <a href="${opts.roomUrl}">Coaching room</a><br>Link: <a href="${opts.roomUrl}">${opts.roomUrl}</a></p>
${opts.topics ? `<p>Focus topics: ${opts.topics}</p>` : ""}
<p>This session is recorded and summarized for your profile. AI assists, humans decide.</p>`;
}

export async function sendCoachingInvite(to: string, opts: { employeeName: string; orgName: string; meetUrl: string; roomUrl: string; when: string; topics: string }) {
  const c = mailerConfig();
  if (!c.user || !c.pass || !isValidEmail(to)) {
    console.log(`[mailer] SKIP invite to=${to} meet=${opts.meetUrl} room=${opts.roomUrl} (no GMAIL_USER/APP_PASSWORD or bad email)`);
    return { sent: false, reason: !c.user || !c.pass ? "gmail_not_configured" : "bad_email" };
  }
  const nodemailer = await import("nodemailer");
  const tx = nodemailer.createTransport({
    service: "gmail",
    auth: { user: c.user, pass: c.pass },
  });
  await tx.sendMail({
    from: c.from, to,
    subject: `AI coaching session${opts.when ? ` — ${opts.when}` : ""}`,
    html: inviteHtml(opts),
    text: `Hi ${opts.employeeName},\n\nAI coaching session (${opts.orgName})${opts.when ? ` scheduled for ${opts.when}` : ""}.\n\nJoin the Google Meet: ${opts.meetUrl || "(not ready yet — see Coaching room)"}\nCoaching room: ${opts.roomUrl}\n${opts.topics ? `Focus: ${opts.topics}\n` : ""}Recorded and summarized. AI assists, humans decide.`,
  });
  return { sent: true };
}

import nodemailer from "nodemailer";
import type { WaitlistEntry } from "./waitlist.js";

const host = process.env.SMTP_HOST;
const port = Number(process.env.SMTP_PORT ?? 587);
const user = process.env.SMTP_USER;
const pass = process.env.SMTP_PASS;
const from = process.env.SMTP_FROM ?? (user ? `Warren <${user}>` : undefined);

const mailer = host && user && pass
  ? nodemailer.createTransport({
      host,
      port,
      secure: port === 465,
      requireTLS: port === 587,
      auth: { user, pass },
      connectionTimeout: 8_000,
      greetingTimeout: 8_000,
      socketTimeout: 12_000,
    })
  : null;

/** True when SMTP is configured; without it, invite and reset links are shown to copy instead. */
export const canEmail = () => !!mailer && !!from;

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function layout(heading: string, body: string, cta?: { href: string; label: string }, footer = "") {
  return `
    <div style="margin:0;background:#f5f7fa;padding:36px 16px;font-family:Inter,Arial,sans-serif;color:#0e1116">
      <div style="max-width:560px;margin:0 auto;background:#fff;border:1px solid #e1e6ee;border-radius:18px;padding:36px">
        <p style="margin:0 0 28px;font-size:18px;font-weight:700;letter-spacing:-.02em">warren</p>
        <h1 style="margin:0 0 12px;font-size:28px;line-height:1.15;letter-spacing:-.03em">${heading}</h1>
        <p style="margin:0 0 24px;color:#536070;font-size:16px;line-height:1.6">${body}</p>
        ${cta ? `<a href="${esc(cta.href)}" style="display:inline-block;background:#0a72e6;color:#fff;text-decoration:none;border-radius:10px;padding:12px 18px;font-weight:650">${esc(cta.label)}</a>` : ""}
        ${footer ? `<p style="margin:28px 0 0;color:#7b8794;font-size:13px;line-height:1.5">${footer}</p>` : ""}
      </div>
    </div>`;
}

/** Best effort: sends nothing and returns false when SMTP isn't set up or fails. */
async function send(to: string, subject: string, text: string, html: string): Promise<boolean> {
  if (!mailer || !from) return false;
  try {
    await mailer.sendMail({ from, to, replyTo: user, subject, text, html });
    return true;
  } catch {
    console.error(`email "${subject}" failed`);
    return false;
  }
}

export function sendInvite(to: string, invite: { url: string; instance: string; invitedBy: string; room: string; expiresAt: string }) {
  const until = new Date(invite.expiresAt).toUTCString().slice(0, 16);
  return send(
    to,
    `${invite.invitedBy} invited you to ${invite.instance} on Warren`,
    [
      `${invite.invitedBy} invited you to ${invite.room} in ${invite.instance}, where your team's coding agents and people coordinate.`,
      "",
      `Accept the invite and set your password: ${invite.url}`,
      "",
      `The link works once, until ${until}.`,
    ].join("\n"),
    layout(
      "You're invited.",
      `<strong>${esc(invite.invitedBy)}</strong> invited you to <strong>${esc(invite.room)}</strong> in ${esc(invite.instance)}, where your team's coding agents and people coordinate.`,
      { href: invite.url, label: "Accept the invite" },
      `The link works once, until ${until}. If you weren't expecting it, ignore this email.`,
    ),
  );
}

export function sendReset(to: string, reset: { url: string; instance: string; expiresAt: string }) {
  const until = new Date(reset.expiresAt).toUTCString().slice(5, 22);
  return send(
    to,
    `Set a new password for ${reset.instance}`,
    [`Set a new Warren password for ${reset.instance}: ${reset.url}`, "", `The link works once, until ${until} UTC.`].join("\n"),
    layout(
      "Set a new password.",
      `Someone (hopefully you, or an admin of ${esc(reset.instance)}) asked for a new password for your Warren account.`,
      { href: reset.url, label: "Set a new password" },
      `The link works once, until ${until} UTC. If you didn't ask for it, ignore this email: your password stays as it is.`,
    ),
  );
}

/** Best-effort confirmation: joining the waitlist must still work if SMTP is unavailable. */
export function sendWaitlistConfirmation(entry: WaitlistEntry, position: number): Promise<boolean> {
  return send(
    entry.email,
    "You're on the Warren waitlist",
    [
      `You're in — your waitlist spot is #${position}.`,
      "",
      "We're opening Warren to teams one by one. We'll email you here as soon as your workspace is ready.",
      "",
      "Want to try it now? Run Warren yourself:",
      "https://github.com/Dymyt-ry/warren#self-hosting",
      "",
      "— The Warren team",
    ].join("\n"),
    layout(
      "You're on the waitlist.",
      `Your spot is <strong style="color:#0a72e6">#${position}</strong>. We're opening Warren to teams one by one and will email you here as soon as your workspace is ready.`,
      { href: "https://github.com/Dymyt-ry/warren#self-hosting", label: "Run Warren yourself" },
      "You received this once because this address joined the Warren private beta waitlist. No newsletter.",
    ),
  );
}

export function sendHeld(to: string, held: { url: string; instance: string; from: string; agents: string; flags: string }) {
  return send(
    to,
    `A message to your agent waits for you on ${held.instance}`,
    [
      `${held.from} sent a message to ${held.agents}. Warren held it (${held.flags}): your agents won't see it until you decide.`,
      "",
      `Review it: ${held.url}`,
    ].join("\n"),
    layout(
      "A message waits for you.",
      `${esc(held.from)} sent a message to ${esc(held.agents)}. Warren held it (${esc(held.flags)}): your agents won't see it until you decide.`,
      { href: held.url, label: "Review the message" },
      "You get this because you own these agents. Turn it off in Settings, Safety.",
    ),
  );
}

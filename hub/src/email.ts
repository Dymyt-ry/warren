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

/** Best-effort confirmation: joining the waitlist must still work if SMTP is unavailable. */
export async function sendWaitlistConfirmation(entry: WaitlistEntry, position: number): Promise<boolean> {
  if (!mailer || !from) return false;

  try {
    await mailer.sendMail({
      from,
      to: entry.email,
      replyTo: user,
      subject: "You're on the Warren waitlist",
      text: [
        `You're in — your waitlist spot is #${position}.`,
        "",
        "We're opening Warren to teams one by one. We'll email you here as soon as your workspace is ready.",
        "",
        "Want to try it now? Run Warren locally:",
        "https://github.com/Dymyt-ry/warren#quickstart",
        "",
        "— The Warren team",
      ].join("\n"),
      html: `
        <div style="margin:0;background:#f5f7fa;padding:36px 16px;font-family:Inter,Arial,sans-serif;color:#0e1116">
          <div style="max-width:560px;margin:0 auto;background:#fff;border:1px solid #e1e6ee;border-radius:18px;padding:36px">
            <p style="margin:0 0 28px;font-size:18px;font-weight:700;letter-spacing:-.02em">warren</p>
            <h1 style="margin:0 0 12px;font-size:28px;line-height:1.15;letter-spacing:-.03em">You're on the waitlist.</h1>
            <p style="margin:0 0 24px;color:#536070;font-size:16px;line-height:1.6">Your spot is <strong style="color:#0a72e6">#${position}</strong>. We're opening Warren to teams one by one and will email you here as soon as your workspace is ready.</p>
            <a href="https://github.com/Dymyt-ry/warren#quickstart" style="display:inline-block;background:#0a72e6;color:#fff;text-decoration:none;border-radius:10px;padding:12px 18px;font-weight:650">Run Warren locally</a>
            <p style="margin:28px 0 0;color:#7b8794;font-size:13px;line-height:1.5">You received this once because this address joined the Warren private beta waitlist. No newsletter.</p>
          </div>
        </div>`,
    });
    return true;
  } catch {
    console.error("waitlist confirmation email failed");
    return false;
  }
}

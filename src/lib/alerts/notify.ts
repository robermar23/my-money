import "server-only";

import nodemailer from "nodemailer";

/**
 * Notification-ONLY alert email (Phase 6, ADR-015).
 *
 * CLAUDE.md §Privacy is absolute: financial data never leaves the box. So this
 * email is a doorbell, not a statement — it carries a COUNT and a sign-in link,
 * and **no amounts, account names, merchants, or symbols**. Even a third-party
 * SMTP relay sees nothing financial. The figures live only in the authenticated
 * `/alerts` page.
 *
 * Transport is a user-configured SMTP server (`SMTP_URL`) via `nodemailer` — we
 * ship no default relay and no SaaS API key. The email is purely additive: if
 * SMTP is unset (or the send fails), alerts still land in `/alerts`, which is the
 * system of record.
 *
 * `createTransport` is injectable so the privacy-regression test can assert the
 * rendered body contains no financial data without sending anything.
 */

export interface MailMessage {
  readonly from: string;
  readonly to: string;
  readonly subject: string;
  readonly text: string;
}

export interface MailTransport {
  sendMail(message: MailMessage): Promise<unknown>;
}

export interface NotifyDeps {
  readonly env?: Record<string, string | undefined>;
  readonly createTransport?: (url: string) => MailTransport;
}

export interface NotifyResult {
  readonly sent: boolean;
}

/** Build the content-free notification body. Exported for the privacy test. */
export function buildNotification(
  count: number,
  date: string,
  baseUrl: string,
): { subject: string; text: string } {
  const plural = count === 1 ? "alert" : "alerts";
  return {
    subject: `my-money: ${count} new ${plural}`,
    text: [
      `my-money detected ${count} new ${plural} on ${date}.`,
      "",
      `Sign in to review: ${baseUrl.replace(/\/$/, "")}/alerts`,
      "",
      "(This message intentionally contains no financial details.)",
    ].join("\n"),
  };
}

/**
 * Send the notification-only email IF SMTP is configured and there is at least
 * one new alert. Returns `{ sent: false }` (no throw) when disabled or empty —
 * email is best-effort, never the source of truth.
 */
export async function notifyNewAlerts(
  count: number,
  date: string,
  deps: NotifyDeps = {},
): Promise<NotifyResult> {
  const env = deps.env ?? process.env;
  const smtpUrl = env.SMTP_URL?.trim();
  const to = env.ALERT_EMAIL_TO?.trim();

  if (!smtpUrl || !to || count <= 0) return { sent: false };

  const from = env.ALERT_EMAIL_FROM?.trim() || to;
  const baseUrl = env.APP_BASE_URL?.trim() || "http://localhost:4000";
  const { subject, text } = buildNotification(count, date, baseUrl);

  const make = deps.createTransport ?? ((url: string) => nodemailer.createTransport(url));
  const transport = make(smtpUrl);
  await transport.sendMail({ from, to, subject, text });
  return { sent: true };
}

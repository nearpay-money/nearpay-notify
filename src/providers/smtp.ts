/**
 * SMTP provider (local: Mailpit; beta: Resend `smtps://smtp.resend.com:465`, user `resend`, the API key as password).
 *
 * Transport: `smtps://` is implicit TLS (port 465 by default), `smtp://` upgrades with STARTTLS — required on the
 * server stage, where certificates are always verified (TLS 1.2+). Credentials: `NP_SMTP_USER` plus the password
 * from `NP_SMTP_PASSWORD_FILE` (a secret file); a password inside `NP_SMTP_URL` is accepted on local/test stacks only.
 * Query parameters of the URL are ignored (nodemailer would read flags such as `ignoreTLS` from them).
 *
 * Reply codes: a 5xx at the recipient stage (550/551/553 on RCPT TO, envelope errors) rejects the recipient →
 * suppressed. Other 5xx are permanent for the message only. Authentication, connection and TLS failures, 4xx, and
 * provider quota or rate-limit replies (whatever their code) are transient: they say nothing about the recipient,
 * so they never suppress an address, and the job retries with backoff.
 */
import nodemailer from "nodemailer";
import type SMTPTransport from "nodemailer/lib/smtp-transport/index.js";
import { type EmailProvider, type OutgoingEmail, ProviderError } from "./provider.js";

const RECIPIENT_REJECTED = new Set([550, 551, 553]);
/** Authentication refused or unavailable: a configuration problem, never the recipient's. */
const AUTH_CODES = new Set([454, 530, 534, 535, 538]);
const QUOTA = /quota|rate.?limit|too many (messages|emails|requests|connections)|sending limit|daily limit/i;

export function classifySmtpError(e: unknown): ProviderError {
  const err = e as { responseCode?: number; code?: string; command?: string; message?: string };
  const code = err.responseCode;
  const message = `${err.code ?? "SMTP"}${code ? ` ${code}` : ""}: ${err.message ?? String(e)}`;
  if (err.code === "EAUTH" || (typeof code === "number" && AUTH_CODES.has(code)))
    return new ProviderError(message, false);
  if (QUOTA.test(err.message ?? "")) return new ProviderError(message, false);
  if (typeof code === "number" && code >= 500 && code < 600) {
    const recipientStage = err.code === "EENVELOPE" || /^RCPT/i.test(err.command ?? "");
    return new ProviderError(message, true, recipientStage && RECIPIENT_REJECTED.has(code));
  }
  if (err.code === "EENVELOPE" && code === undefined) return new ProviderError(message, true, true);
  return new ProviderError(message, false);
}

export interface SmtpOptions {
  readonly url: string;
  readonly timeoutMs: number;
  /** Domain of the From address: `Message-ID` right-hand side and the EHLO name. */
  readonly domain: string;
  /** `NP_ENV`: TLS and credential rules are strict on every stage but `local` and `test`. */
  readonly env: string;
  readonly user?: string | undefined;
  readonly password?: string | undefined;
}

const devEnv = (env: string) => env === "local" || env === "test";

/** Nodemailer transport options from the SMTP settings (throws on an unsafe or inconsistent configuration). */
export function smtpTransportOptions(o: SmtpOptions): SMTPTransport.Options {
  const u = new URL(o.url);
  if (u.protocol !== "smtp:" && u.protocol !== "smtps:") throw new Error("NP_SMTP_URL must be smtp:// or smtps://");
  const strict = !devEnv(o.env);
  const implicitTls = u.protocol === "smtps:";
  const urlUser = decodeURIComponent(u.username);
  const urlPassword = decodeURIComponent(u.password);
  if (urlPassword && o.password !== undefined)
    throw new Error("NP_SMTP_URL carries a password and NP_SMTP_PASSWORD_FILE is set: use one of them");
  if (urlPassword && strict)
    throw new Error(
      "NP_SMTP_URL must not carry a password on the server stage: use NP_SMTP_USER and NP_SMTP_PASSWORD_FILE",
    );
  const user = o.user ?? (urlUser || undefined);
  const pass = o.password ?? (urlPassword || undefined);
  if (pass !== undefined && user === undefined) throw new Error("NP_SMTP_PASSWORD_FILE needs NP_SMTP_USER");
  if (user !== undefined && pass === undefined) throw new Error("NP_SMTP_USER needs NP_SMTP_PASSWORD_FILE");
  const host = u.hostname.replace(/^\[|\]$/g, "");
  return {
    host,
    port: u.port ? Number(u.port) : implicitTls ? 465 : 587,
    secure: implicitTls,
    // STARTTLS is mandatory off local/test stacks: never send credentials or mail in clear text
    requireTLS: !implicitTls && strict,
    name: o.domain,
    ...(user !== undefined && pass !== undefined ? { auth: { user, pass } } : {}),
    tls: { minVersion: "TLSv1.2", rejectUnauthorized: true, servername: host },
    connectionTimeout: o.timeoutMs,
    greetingTimeout: o.timeoutMs,
    socketTimeout: o.timeoutMs,
  };
}

/** Headers of every mail: no auto-replies (out-of-office loops back to Reply-To), message correlation. */
export function standardHeaders(id: string): Record<string, string> {
  return {
    "Auto-Submitted": "auto-generated",
    "X-Auto-Response-Suppress": "All",
    "X-NearPay-Message": id,
  };
}

export function smtpProvider(o: SmtpOptions): EmailProvider {
  const transport = nodemailer.createTransport(smtpTransportOptions(o));
  return {
    name: "smtp",
    async send(m: OutgoingEmail) {
      try {
        const info = await transport.sendMail({
          from: m.from,
          ...(m.replyTo ? { replyTo: m.replyTo } : {}),
          to: m.to,
          subject: m.subject,
          html: m.html,
          text: m.text,
          messageId: `<${m.id}@${o.domain}>`,
          headers: standardHeaders(m.id),
        });
        return { providerMessageId: String(info.messageId ?? `<${m.id}@${o.domain}>`) };
      } catch (e) {
        throw classifySmtpError(e);
      }
    },
    async close() {
      transport.close();
    },
  };
}

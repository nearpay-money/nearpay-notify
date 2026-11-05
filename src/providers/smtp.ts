/**
 * SMTP provider (local: Mailpit). SMTP reply codes: 5xx is permanent (550/551/553 reject the
 * recipient → suppressed), 4xx and connection errors/timeouts are transient.
 */
import nodemailer from "nodemailer";
import { type EmailProvider, type OutgoingEmail, ProviderError } from "./provider.js";

const RECIPIENT_REJECTED = new Set([550, 551, 553]);

export function classifySmtpError(e: unknown): ProviderError {
  const err = e as { responseCode?: number; code?: string; message?: string };
  const code = err.responseCode;
  const message = `${err.code ?? "SMTP"}${code ? ` ${code}` : ""}: ${err.message ?? String(e)}`;
  if (typeof code === "number" && code >= 500 && code < 600)
    return new ProviderError(message, true, RECIPIENT_REJECTED.has(code));
  if (err.code === "EENVELOPE" && code === undefined) return new ProviderError(message, true, true);
  return new ProviderError(message, false);
}

export function smtpProvider(o: { url: string; timeoutMs: number; domain: string }): EmailProvider {
  const transport = nodemailer.createTransport(o.url, {
    connectionTimeout: o.timeoutMs,
    greetingTimeout: o.timeoutMs,
    socketTimeout: o.timeoutMs,
  } as never);
  return {
    name: "smtp",
    async send(m: OutgoingEmail) {
      try {
        const info = await transport.sendMail({
          from: m.from,
          to: m.to,
          subject: m.subject,
          html: m.html,
          text: m.text,
          messageId: `<${m.id}@${o.domain}>`,
          headers: { "Auto-Submitted": "auto-generated", "X-NearPay-Message": m.id },
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

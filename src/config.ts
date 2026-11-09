/** Configuration (lld/notify.md §7, foundations §13). */
import { baseConfigShape, flag, list, loadConfig, secret, url } from "@nearpay-internal/service";
import { z } from "zod";

const email = z.email();
const mailbox = z.string().regex(/^[^<>\r\n]{1,100} <[^<>\s@]+@[^<>\s@]+>$/, "expected `Name <address>`");

const shared = {
  ...baseConfigShape,
  dbUrl: secret(url(["postgres:", "postgresql:"])),
  /** KEK for recipients and variables at rest (envelope encryption) and the recipient-hash key. */
  piiKek: secret(),
};

export const apiShape = { ...shared };

export const workerShape = {
  ...shared,
  natsUrl: url(["nats:", "tls:"]),
  /** `smtp`: Mailpit locally, any SMTP relay on the server (beta: Resend). */
  emailProvider: z.enum(["smtp"]).default("smtp"),
  /** `smtps://host[:465]` (implicit TLS) or `smtp://host[:587]` (STARTTLS, required on the server stage); no password. */
  smtpUrl: url(["smtp:", "smtps:"]).default("smtp://mailpit:1025"),
  /** SMTP user (Resend: `resend`); the password comes from NP_SMTP_PASSWORD_FILE. */
  smtpUser: z.string().min(1).max(200).optional(),
  /** SMTP password (Resend: the API key), from a secret file only. */
  smtpPassword: secret().optional(),
  /** `Name <address>`. */
  from: mailbox.default("NearPay <no-reply@nearpay.money>"),
  /** `Reply-To` of every mail (`Name <address>` or a bare address); unset: none. */
  replyTo: z.union([mailbox, email]).optional(),
  /**
   * Sends per UTC day across all mail (the provider plan, e.g. Resend free: 100/day; keep headroom for the
   * alert mails Alertmanager sends through the same account). 0: no cap.
   */
  emailDailyCap: z.coerce.number().int().min(0).max(1_000_000).default(0),
  /** The last slots of the day kept for sign-in links, security and ops alerts and invitations. */
  emailDailyReserve: z.coerce.number().int().min(0).max(1_000_000).default(10),
  /** Ops recipients of kill-switch, audit-finding and approval-request alerts (comma-separated). */
  securityContacts: list(email).default([]),
  /** Customer receipts for test-mode payments (true only where every mail is caught, e.g. Mailpit). */
  testModeReceipts: flag(false),
  dashboardOrigin: url(["https:", "http:"]).default("https://dashboard.nearpay.localhost"),
  /** Link target in ops approval mails (the console, `ops.<domain>`). */
  consoleOrigin: url(["https:", "http:"]).default("https://ops.nearpay.localhost"),
  identityUrl: url(["http:", "https:"]),
  paymentsUrl: url(["http:", "https:"]),
  /** Billing internal API (stage 3: invoice and subscription notification contexts). */
  billingUrl: url(["http:", "https:"]),
  serviceClientSecret: secret(),
  /** Provider call timeout (LLD §6: 5 s). */
  sendTimeoutMs: z.coerce.number().int().min(500).max(60_000).default(5_000),
  /** Messages (encrypted recipients and variables) are deleted after this many days. */
  messageRetentionDays: z.coerce.number().int().min(1).max(3650).default(90),
  /** Per-recipient limit (LLD §6: 20 per hour). */
  recipientHourlyLimit: z.coerce.number().int().min(1).max(10_000).default(20),
};

export const migrateShape = { ...baseConfigShape, dbUrl: secret(url(["postgres:", "postgresql:"])) };

export type ApiConfig = z.output<z.ZodObject<typeof apiShape>>;
export type WorkerConfig = z.output<z.ZodObject<typeof workerShape>>;

export const readApiConfig = () => loadConfig(apiShape);
export const readWorkerConfig = () => checkWorkerConfig(loadConfig(workerShape));

/**
 * Server-stage rules (every NP_ENV but local/test): mail links point at public https origins (never a
 * `*.localhost` default left in place by a missing variable).
 */
export function checkWorkerConfig<C extends Pick<WorkerConfig, "env" | "dashboardOrigin" | "consoleOrigin">>(c: C): C {
  if (c.env === "local" || c.env === "test") return c;
  for (const [name, value] of [
    ["NP_DASHBOARD_ORIGIN", c.dashboardOrigin],
    ["NP_CONSOLE_ORIGIN", c.consoleOrigin],
  ] as const) {
    const u = new URL(value);
    if (u.protocol !== "https:" || u.hostname === "localhost" || u.hostname.endsWith(".localhost"))
      throw new Error(`${name} must be a public https origin on the server stage (got ${value})`);
  }
  return c;
}

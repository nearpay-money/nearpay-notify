/** Configuration (lld/notify.md §7, foundations §13). */
import { baseConfigShape, flag, list, loadConfig, secret, url } from "@nearpay-internal/service";
import { z } from "zod";

const email = z.email();

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
  /** `smtp` locally (Mailpit); `postmark` on the server arrives in Stage 5. */
  emailProvider: z.enum(["smtp"]).default("smtp"),
  smtpUrl: url(["smtp:", "smtps:"]).default("smtp://mailpit:1025"),
  /** `Name <address>`. */
  from: z
    .string()
    .regex(/^[^<>\r\n]{1,100} <[^<>\s@]+@[^<>\s@]+>$/, "expected `Name <address>`")
    .default("NearPay <no-reply@nearpay.money>"),
  /** Ops recipients of kill-switch, audit-finding and approval-request alerts (comma-separated). */
  securityContacts: list(email).default([]),
  /** Customer receipts for test-mode payments (true only where every mail is caught, e.g. Mailpit). */
  testModeReceipts: flag(false),
  dashboardOrigin: url(["https:", "http:"]).default("https://dashboard.nearpay.localhost"),
  /** Link target in ops approval mails (the console, `ops.<domain>`). */
  consoleOrigin: url(["https:", "http:"]).default("https://ops.nearpay.localhost"),
  identityUrl: url(["http:", "https:"]),
  paymentsUrl: url(["http:", "https:"]),
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
export const readWorkerConfig = () => loadConfig(workerShape);

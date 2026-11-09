/** Dependencies shared by notify use cases. */
import type { EnvelopeCipher, Kysely, Transaction } from "@nearpay-internal/db";
import { sql } from "@nearpay-internal/db";
import type { Logger, ServiceMetrics } from "@nearpay-internal/service";
import type { DB } from "../infra/db/schema.js";

export interface NotifyMetrics {
  /** A message reached a final status (or was queued). */
  message(labels: { template: string; status: string }): void;
  sendSeconds(provider: string, seconds: number): void;
  /** The daily send cap refused a message (`outcome`: deferred to the next UTC day, or failed). */
  capped(labels: { template: string; outcome: "deferred" | "failed" }): void;
}

export interface Notify {
  readonly db: Kysely<DB>;
  readonly cipher: EnvelopeCipher;
  /** HMAC key for recipient hashes (derived from the KEK). */
  readonly hashKey: Buffer;
  readonly log: Logger;
  readonly metrics: NotifyMetrics;
}

export type Tx = Transaction<DB>;

export const noMetrics: NotifyMetrics = { message() {}, sendSeconds() {}, capped() {} };

export function notifyMetrics(m: ServiceMetrics): NotifyMetrics {
  const total = m.counter("messages_total", "Messages by template and status (queued, sent, failed, suppressed).", [
    "template",
    "status",
  ]);
  const seconds = m.histogram("send_duration_seconds", "Provider send latency.", ["provider"]);
  const capped = m.counter("email_capped_total", "Messages the daily send cap deferred or failed (alert on any).", [
    "template",
    "outcome",
  ]);
  return {
    message: (l) => total.inc(l),
    sendSeconds: (provider, s) => seconds.observe({ provider }, s),
    capped: (l) => capped.inc(l),
  };
}

export async function dbNow(db: Kysely<DB> | Tx): Promise<Date> {
  const r = await sql<{ now: Date }>`select now() as now`.execute(db);
  return (r.rows[0] as { now: Date }).now;
}

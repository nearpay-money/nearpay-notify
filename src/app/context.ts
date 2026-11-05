/** Dependencies shared by notify use cases. */
import type { EnvelopeCipher, Kysely, Transaction } from "@nearpay-internal/db";
import { sql } from "@nearpay-internal/db";
import type { Logger, ServiceMetrics } from "@nearpay-internal/service";
import type { DB } from "../infra/db/schema.js";

export interface NotifyMetrics {
  /** A message reached a final status (or was queued). */
  message(labels: { template: string; status: string }): void;
  sendSeconds(provider: string, seconds: number): void;
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

export const noMetrics: NotifyMetrics = { message() {}, sendSeconds() {} };

export function notifyMetrics(m: ServiceMetrics): NotifyMetrics {
  const total = m.counter("messages_total", "Messages by template and status (queued, sent, failed, suppressed).", [
    "template",
    "status",
  ]);
  const seconds = m.histogram("send_duration_seconds", "Provider send latency.", ["provider"]);
  return {
    message: (l) => total.inc(l),
    sendSeconds: (provider, s) => seconds.observe({ provider }, s),
  };
}

export async function dbNow(db: Kysely<DB> | Tx): Promise<Date> {
  const r = await sql<{ now: Date }>`select now() as now`.execute(db);
  return (r.rows[0] as { now: Date }).now;
}

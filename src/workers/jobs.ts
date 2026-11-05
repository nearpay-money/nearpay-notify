/**
 * Jobs (lld/notify.md §6), run by the job worker (foundations §7: leases, backoff, dead letters):
 *
 * | kind           | enqueued by                     | what                                         |
 * |----------------|---------------------------------|----------------------------------------------|
 * | event.notify   | consumers (one per event)       | resolve recipients, queue one message each   |
 * | message.send   | queueMessage (one per message)  | suppression, limit, render, provider call    |
 * | purge.messages | daily 05:30 UTC (recurring)     | delete messages older than the retention     |
 * | kit.purge      | hourly (recurring)              | published outbox, old inbox, idempotency keys |
 */
import type { Envelope } from "@nearpay-internal/bus";
import { type JobHandler, purgeKitTables, type RecurringJob, sql } from "@nearpay-internal/db";
import { EVENT_JOB, type FanoutDeps, fanOut } from "../app/fanout.js";
import { SEND_JOB } from "../app/messages.js";
import { type SendDeps, sendQueued } from "../app/send.js";

const HOUR = 3_600_000;
export const RECURRING: readonly RecurringJob[] = [
  { kind: "purge.messages", everyMs: 24 * HOUR, offsetMs: 5.5 * HOUR },
  { kind: "kit.purge", everyMs: HOUR },
];

export function jobHandlers(
  fanout: FanoutDeps,
  send: SendDeps,
  o: { retentionDays: number },
): Record<string, JobHandler> {
  return {
    [EVENT_JOB]: async (payload) => {
      const e = payload as Envelope;
      const r = await fanOut(fanout, e);
      fanout.n.log.info({ event: e.id, subject: e.subject, ...r }, "event fanned out");
    },
    [SEND_JOB]: async (payload, ctx) => {
      await sendQueued(send, (payload as { message_id: string }).message_id, ctx.attempt);
    },
    "purge.messages": async () => {
      const r =
        await sql`delete from messages where created_at < now() - make_interval(days => ${o.retentionDays})`.execute(
          fanout.n.db,
        );
      fanout.n.log.info({ deleted: Number(r.numAffectedRows ?? 0n) }, "messages purged");
    },
    "kit.purge": async () => {
      fanout.n.log.info(await purgeKitTables(fanout.n.db), "kit tables purged");
    },
  };
}

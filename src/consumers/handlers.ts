/**
 * Domain-event consumers (lld/notify.md §4). Each handler runs in the inbox transaction and only
 * enqueues the `event.notify` job (recipient resolution needs other services; see app/fanout.ts).
 * Events that send nothing (a passing audit finding, test-mode receipts when they are off) enqueue
 * nothing.
 */
import type { EventHandler } from "@nearpay-internal/bus";
import { deadLetterSink, enqueueJob, inboxHandler, type Kysely } from "@nearpay-internal/db";
import type { Subject } from "@nearpay-internal/spec";
import { EVENT_JOB, EVENT_JOB_ATTEMPTS } from "../app/fanout.js";
import { NOTIFY_SUBJECTS, planFor, type RoutingOptions } from "../domain/message/routing.js";
import type { DB } from "../infra/db/schema.js";

export function notifyHandlers(db: Kysely<DB>, routing: RoutingOptions): Partial<Record<Subject, EventHandler>> {
  const handler = inboxHandler(db, async (tx, e) => {
    if ("skip" in planFor(e, routing)) return;
    await enqueueJob(tx, {
      kind: EVENT_JOB,
      payload: e,
      dedupeKey: `${EVENT_JOB}:${e.id}`,
      maxAttempts: EVENT_JOB_ATTEMPTS,
    });
  });
  return Object.fromEntries(NOTIFY_SUBJECTS.map((s) => [s, handler]));
}

export const deadLetters = (db: Kysely<DB>) => deadLetterSink(db, "consumer:notify");

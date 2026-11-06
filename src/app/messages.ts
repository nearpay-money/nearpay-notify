/**
 * Queueing (lld/notify.md §5–§6): one `messages` row per recipient and one `message.send` job, in
 * the caller's transaction. The dedupe key (`<template>:<key>`) makes repeated requests and event
 * redeliveries return the existing message instead of sending twice (INV-4).
 */
import { enqueueJob, withTx } from "@nearpay-internal/db";
import { uuidv7 } from "@nearpay-internal/ids";
import { maxAttempts, recipientHash } from "../domain/message/policy.js";
import { type Locale, parseVariables, type TemplateName } from "../domain/template/catalogue.js";
import type { Notify, Tx } from "./context.js";

export const SEND_JOB = "message.send";

export interface QueueInput {
  template: TemplateName;
  to: string;
  variables: unknown;
  locale: Locale;
  /** Caller key, unique per intended message (e.g. `<event id>:<user id>`). */
  dedupeKey: string;
  source: string;
  accountUuid?: string | null;
  livemode?: boolean | null;
}

/** AAD binding each ciphertext to its message and field. */
export const aad = (id: string, field: "to" | "variables") => `msg:${id}:${field}`;

export async function queueMessage(n: Notify, tx: Tx, i: QueueInput): Promise<{ id: string; created: boolean }> {
  const variables = parseVariables(i.template, i.variables);
  const id = uuidv7();
  const dedupe = `${i.template}:${i.dedupeKey}`;
  const inserted = await tx
    .insertInto("messages")
    .values({
      id,
      account_id: i.accountUuid ?? null,
      livemode: i.livemode ?? null,
      template: i.template,
      locale: i.locale,
      to_hash: recipientHash(n.hashKey, i.to),
      to_enc: n.cipher.encrypt(i.to.trim(), aad(id, "to")),
      variables_enc: n.cipher.encrypt(JSON.stringify(variables), aad(id, "variables")),
      status: "queued",
      dedupe_key: dedupe,
      source: i.source,
    })
    .onConflict((oc) => oc.column("dedupe_key").doNothing())
    .returning("id")
    .executeTakeFirst();
  if (!inserted) {
    const existing = await tx
      .selectFrom("messages")
      .select("id")
      .where("dedupe_key", "=", dedupe)
      .executeTakeFirstOrThrow();
    return { id: existing.id, created: false };
  }
  await enqueueJob(tx, {
    kind: SEND_JOB,
    payload: { message_id: id },
    dedupeKey: `${SEND_JOB}:${id}`,
    // the upper bound; the worker ends earlier when it has no fallback provider (policy.afterFailure)
    maxAttempts: maxAttempts(true),
  });
  n.metrics.message({ template: i.template, status: "queued" });
  return { id, created: true };
}

/** `POST /internal/messages` (identity: magic links). */
export async function queueApiMessage(n: Notify, i: Omit<QueueInput, "source">) {
  return withTx(n.db, (tx) => queueMessage(n, tx, { ...i, source: "api" }));
}

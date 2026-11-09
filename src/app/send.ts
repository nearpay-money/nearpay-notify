/**
 * The `message.send` job (lld/notify.md §6): suppression check, per-recipient hourly limit, render,
 * provider call (5 s), then the final status. Transient failures rethrow (the job retries with
 * backoff, then the fallback provider); permanent ones end the message as `failed`, and a rejected
 * recipient is suppressed. At-least-once: a crash after the provider accepted re-sends with the same
 * `Message-ID`.
 */
import { enqueueJob, sql } from "@nearpay-internal/db";
import {
  afterFailure,
  cappedOutcome,
  type DailyCap,
  dailyCeiling,
  maxAttempts,
  nextUtcDay,
  overHourlyLimit,
  providerFor,
  type SendFailure,
  utcDay,
} from "../domain/message/policy.js";
import { resolveLocale, type TemplateName } from "../domain/template/catalogue.js";
import type { MessageStatus } from "../infra/db/schema.js";
import { type EmailProvider, ProviderError } from "../providers/provider.js";
import { dbNow, type Notify } from "./context.js";
import { aad, SEND_JOB } from "./messages.js";
import type { Renderer } from "./render.js";

export interface SendDeps {
  readonly n: Notify;
  readonly render: Renderer;
  readonly primary: EmailProvider;
  readonly fallback?: EmailProvider;
  readonly from: string;
  /** `Reply-To` of every mail (optional). */
  readonly replyTo?: string;
  readonly hourlyLimit: number;
  /** Daily send cap (provider plan limit); absent or limit 0: no cap. */
  readonly dailyCap?: DailyCap;
  /** Called once per UTC day (per process) when the cap first refuses a message: the operator alert. */
  readonly onCapReached?: (info: { day: string; limit: number; template: string }) => void;
}

export type SendResult = MessageStatus | "skipped" | "retry" | "deferred";

/**
 * Templates whose variables hold a bearer link, wiped once sent: single-use credentials (magic,
 * invitation, enrolment links) and, since stage 3, the hosted invoice link, whose fragment is the
 * long-lived invoice secret (stage 4: also the mandate mails' `manage_url`) (billing serves it again through its context whenever a mail needs it).
 */
export const CREDENTIAL_TEMPLATES: ReadonlySet<string> = new Set([
  "auth.magic_link",
  "team.invitation",
  "ops.enrolment",
  "invoice.issued",
  "invoice.reminder",
  "invoice.paid",
  // stage 4: `manage_url` is the latest invoice's hosted link (with its secret)
  "mandate.activated",
  "mandate.insufficient_funds",
  "mandate.canceled",
  "mandate.unlinked",
  "mandate.released",
]);

async function finish(
  d: SendDeps,
  m: { id: string; template: string },
  status: Exclude<MessageStatus, "queued">,
  fields: { provider?: string; provider_message_id?: string; last_error?: string | null; attempts: number },
) {
  const now = await dbNow(d.n.db);
  await d.n.db
    .updateTable("messages")
    .set({ status, ...fields, ...(status === "sent" ? { sent_at: now } : {}), updated_at: now })
    .where("id", "=", m.id)
    .where("status", "=", "queued")
    .execute();
  d.n.metrics.message({ template: m.template, status });
}

/** Sends one queued message; `attempt` is the 1-based job attempt. */
export async function sendQueued(d: SendDeps, messageId: string, attempt: number): Promise<SendResult> {
  const m = await d.n.db.selectFrom("messages").selectAll().where("id", "=", messageId).executeTakeFirst();
  if (m?.status !== "queued") return "skipped";
  const log = d.n.log.child({ message: messageId, template: m.template, attempt });

  const suppressed = await d.n.db
    .selectFrom("suppressions")
    .select("reason")
    .where("to_hash", "=", m.to_hash)
    .executeTakeFirst();
  if (suppressed) {
    await finish(d, m, "suppressed", { last_error: `suppressed: ${suppressed.reason}`, attempts: attempt - 1 });
    log.info({ reason: suppressed.reason }, "recipient suppressed");
    return "suppressed";
  }
  const recent = await sql<{ n: string }>`
    select count(*)::text as n from messages
    where to_hash = ${m.to_hash} and status = 'sent' and sent_at > now() - interval '1 hour'`.execute(d.n.db);
  if (overHourlyLimit(Number(recent.rows[0]?.n ?? 0), d.hourlyLimit)) {
    await finish(d, m, "suppressed", { last_error: "rate_limited", attempts: attempt - 1 });
    log.warn({ limit: d.hourlyLimit }, "recipient over the hourly limit; message suppressed");
    return "suppressed";
  }

  if (d.dailyCap && d.dailyCap.limit > 0) {
    const capped = await takeDailySlot(d, d.dailyCap, m);
    if (capped) return capped;
  }

  const slot = providerFor(attempt, d.fallback !== undefined);
  if (slot === null) {
    await finish(d, m, "failed", { last_error: m.last_error ?? "no attempts left", attempts: attempt - 1 });
    return "failed";
  }
  const provider = slot === "primary" ? d.primary : (d.fallback as EmailProvider);

  let email: { to: string; subject: string; html: string; text: string };
  try {
    const to = d.n.cipher.decrypt(m.to_enc, aad(m.id, "to")).toString("utf8");
    const variables = JSON.parse(d.n.cipher.decrypt(m.variables_enc, aad(m.id, "variables")).toString("utf8"));
    email = { to, ...(await d.render(m.template as TemplateName, variables, resolveLocale(m.locale))) };
  } catch (e) {
    // a message that cannot be rendered never will be: fail it, do not retry
    await finish(d, m, "failed", { last_error: `render: ${(e as Error).message}`.slice(0, 500), attempts: attempt });
    log.error({ err: e }, "message could not be rendered");
    return "failed";
  }

  const started = performance.now();
  try {
    const r = await provider.send({ id: m.id, from: d.from, ...(d.replyTo ? { replyTo: d.replyTo } : {}), ...email });
    d.n.metrics.sendSeconds(provider.name, (performance.now() - started) / 1000);
    await finish(d, m, "sent", {
      provider: provider.name,
      provider_message_id: r.providerMessageId,
      last_error: null,
      attempts: attempt,
    });
    // a sent magic, invitation, enrolment or hosted invoice link is a live credential: do not keep it, even encrypted
    if (CREDENTIAL_TEMPLATES.has(m.template))
      await d.n.db
        .updateTable("messages")
        .set({ variables_enc: d.n.cipher.encrypt("{}", aad(m.id, "variables")) })
        .where("id", "=", m.id)
        .execute();
    return "sent";
  } catch (e) {
    d.n.metrics.sendSeconds(provider.name, (performance.now() - started) / 1000);
    const failure: SendFailure =
      e instanceof ProviderError ? e : new ProviderError(String((e as Error)?.message ?? e), false);
    const outcome = afterFailure(failure, attempt, d.fallback !== undefined);
    if (outcome.kind === "retry") {
      await d.n.db
        .updateTable("messages")
        .set({
          attempts: attempt,
          last_error: `${provider.name}: ${failure.message}`.slice(0, 500),
          provider: provider.name,
        })
        .where("id", "=", m.id)
        .execute();
      log.warn({ provider: provider.name, err: failure.message }, "send failed; will retry");
      throw e;
    }
    if (outcome.suppress) {
      await d.n.db
        .insertInto("suppressions")
        .values({ to_hash: m.to_hash, reason: "hard_bounce", detail: failure.message.slice(0, 500) })
        .onConflict((oc) => oc.column("to_hash").doNothing())
        .execute();
    }
    await finish(d, m, "failed", {
      provider: provider.name,
      last_error: `${provider.name}: ${failure.message}`.slice(0, 500),
      attempts: attempt,
    });
    log.error({ provider: provider.name, err: failure.message, suppressed: outcome.suppress }, "message failed");
    return "failed";
  }
}

/** UTC days the cap alert already fired for, per worker (its SendDeps). */
const alerted = new WeakMap<SendDeps, string>();

/**
 * Reserves one of today's send slots (atomic conditional increment, so concurrent workers never overshoot), or
 * handles a message the cap refuses: short-lived links and messages queued too long ago fail (`daily_cap`), the
 * rest are deferred to the next UTC day by a new `message.send` job (the message stays queued). Returns null when
 * a slot was taken. A slot stays taken when the provider call then fails (the cap errs on the safe side).
 */
async function takeDailySlot(
  d: SendDeps,
  cap: DailyCap,
  m: { id: string; template: string; created_at: Date; attempts: number },
): Promise<SendResult | null> {
  const now = await dbNow(d.n.db);
  const day = utcDay(now);
  const ceiling = dailyCeiling(cap, m.template);
  // the insert branch (first send of the day) is within any ceiling >= 1
  const taken =
    ceiling > 0 &&
    (
      await sql<{ sent: number }>`
        insert into email_daily_counts as c (day, sent) values (${day}::date, 1)
        on conflict (day) do update set sent = c.sent + 1 where c.sent < ${ceiling}
        returning c.sent`.execute(d.n.db)
    ).rows.length === 1;
  if (taken) return null;
  await sql`
    insert into email_daily_counts as c (day, sent, capped_at) values (${day}::date, 0, now())
    on conflict (day) do update set capped_at = coalesce(c.capped_at, now())`.execute(d.n.db);
  const log = d.n.log.child({ message: m.id, template: m.template });
  if (alerted.get(d) !== day) {
    alerted.set(d, day);
    log.error(
      { day, limit: cap.limit, reserve: cap.reserve },
      "daily email cap reached: non-essential mail is deferred to the next UTC day (NP_EMAIL_DAILY_CAP)",
    );
    d.onCapReached?.({ day, limit: cap.limit, template: m.template });
  }
  if (cappedOutcome(m.template, m.created_at, now) === "fail") {
    await finish(d, m, "failed", { last_error: "daily_cap", attempts: m.attempts });
    d.n.metrics.capped({ template: m.template, outcome: "failed" });
    log.warn("daily email cap: message failed (short-lived link or queued too long)");
    return "failed";
  }
  const runAt = nextUtcDay(now);
  await d.n.db.transaction().execute(async (tx) => {
    await tx
      .updateTable("messages")
      .set({ last_error: `daily_cap: deferred to ${runAt.toISOString()}`, updated_at: now })
      .where("id", "=", m.id)
      .where("status", "=", "queued")
      .execute();
    await enqueueJob(tx, {
      kind: SEND_JOB,
      payload: { message_id: m.id },
      runAt,
      dedupeKey: `${SEND_JOB}:${m.id}:${utcDay(runAt)}`,
      maxAttempts: maxAttempts(true),
    });
  });
  d.n.metrics.capped({ template: m.template, outcome: "deferred" });
  log.warn({ run_at: runAt.toISOString() }, "daily email cap: message deferred");
  return "deferred";
}

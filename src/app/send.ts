/**
 * The `message.send` job (lld/notify.md §6): suppression check, per-recipient hourly limit, render,
 * provider call (5 s), then the final status. Transient failures rethrow (the job retries with
 * backoff, then the fallback provider); permanent ones end the message as `failed`, and a rejected
 * recipient is suppressed. At-least-once: a crash after the provider accepted re-sends with the same
 * `Message-ID`.
 */
import { sql } from "@nearpay-internal/db";
import { afterFailure, overHourlyLimit, providerFor, type SendFailure } from "../domain/message/policy.js";
import { resolveLocale, type TemplateName } from "../domain/template/catalogue.js";
import type { MessageStatus } from "../infra/db/schema.js";
import { type EmailProvider, ProviderError } from "../providers/provider.js";
import { dbNow, type Notify } from "./context.js";
import { aad } from "./messages.js";
import type { Renderer } from "./render.js";

export interface SendDeps {
  readonly n: Notify;
  readonly render: Renderer;
  readonly primary: EmailProvider;
  readonly fallback?: EmailProvider;
  readonly from: string;
  readonly hourlyLimit: number;
}

export type SendResult = MessageStatus | "skipped" | "retry";

/** Templates whose variables are credentials: single-use links (wiped once sent). */
export const CREDENTIAL_TEMPLATES: ReadonlySet<string> = new Set([
  "auth.magic_link",
  "team.invitation",
  "ops.enrolment",
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
    const r = await provider.send({ id: m.id, from: d.from, ...email });
    d.n.metrics.sendSeconds(provider.name, (performance.now() - started) / 1000);
    await finish(d, m, "sent", {
      provider: provider.name,
      provider_message_id: r.providerMessageId,
      last_error: null,
      attempts: attempt,
    });
    // a sent magic, invitation or enrolment link is a live credential until it expires: do not keep it, even encrypted
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

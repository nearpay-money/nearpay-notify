/** The `message.send` job against Postgres with scripted providers (lld/notify.md §6). */
import { sql, withTx } from "@nearpay-internal/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { queueMessage } from "../../src/app/messages.js";
import { createRenderer } from "../../src/app/render.js";
import { type SendDeps, sendQueued } from "../../src/app/send.js";
import type { TemplateName } from "../../src/domain/template/catalogue.js";
import { SAMPLES } from "../../src/domain/template/samples.js";
import { type EmailProvider, type OutgoingEmail, ProviderError } from "../../src/providers/provider.js";
import { jobHandlers } from "../../src/workers/jobs.js";
import { type Stack, startStack } from "../support/stack.js";

let s: Stack;
beforeAll(async () => {
  s = await startStack();
});
afterAll(async () => {
  await s?.stop();
});

/** A provider that plays a script of outcomes (`ok` or an error), then succeeds. */
function scripted(name: string, script: (ProviderError | "ok")[] = []) {
  const sent: OutgoingEmail[] = [];
  const p: EmailProvider & { sent: OutgoingEmail[] } = {
    name,
    sent,
    async send(m) {
      const next = script.shift() ?? "ok";
      if (next !== "ok") throw next;
      sent.push(m);
      return { providerMessageId: `${name}-${sent.length}` };
    },
  };
  return p;
}

const render = createRenderer();
const deps = (primary: EmailProvider, o: Partial<SendDeps> = {}): SendDeps => ({
  n: s.notify,
  render,
  primary,
  from: "NearPay <no-reply@nearpay.money>",
  hourlyLimit: 20,
  ...o,
});
let seq = 0;
async function queue(to: string, template: TemplateName = "account.reinstated") {
  return withTx(s.admin.db, (tx) =>
    queueMessage(s.notify, tx, {
      template,
      to,
      variables: SAMPLES[template][0],
      locale: "en",
      dedupeKey: `test-${seq++}`,
      source: "test",
    }),
  );
}
const row = (id: string) =>
  s.admin.db.selectFrom("messages").selectAll().where("id", "=", id).executeTakeFirstOrThrow();
const transient = () => new ProviderError("ETIMEDOUT: connection timed out", false);

describe("retries and fallback", () => {
  it("a transient failure keeps the message queued and rethrows; the next attempt sends", async () => {
    const p = scripted("smtp", [transient()]);
    const { id } = await queue("retry@example.test");
    await expect(sendQueued(deps(p), id, 1)).rejects.toThrow("ETIMEDOUT");
    expect(await row(id)).toMatchObject({
      status: "queued",
      attempts: 1,
      last_error: "smtp: ETIMEDOUT: connection timed out",
    });
    expect(await sendQueued(deps(p), id, 2)).toBe("sent");
    expect(await row(id)).toMatchObject({
      status: "sent",
      attempts: 2,
      provider: "smtp",
      provider_message_id: "smtp-1",
      last_error: null,
    });
    expect(p.sent[0]).toMatchObject({ id, to: "retry@example.test", from: "NearPay <no-reply@nearpay.money>" });
    expect(p.sent[0]?.subject).toBe("Your NearPay account is active again");
  });

  it("without a fallback, the 8th transient failure is final", async () => {
    const { id } = await queue("final@example.test");
    expect(await sendQueued(deps(scripted("smtp", [transient()])), id, 8)).toBe("failed");
    expect(await row(id)).toMatchObject({ status: "failed", attempts: 8 });
  });

  it("with a fallback, attempts 9–10 go to the fallback provider", async () => {
    const primary = scripted("smtp", [transient()]);
    const fallback = scripted("ses");
    const { id } = await queue("fallback@example.test");
    await expect(sendQueued(deps(primary, { fallback }), id, 8)).rejects.toThrow();
    expect(await sendQueued(deps(primary, { fallback }), id, 9)).toBe("sent");
    expect(await row(id)).toMatchObject({ status: "sent", provider: "ses", attempts: 9 });
    expect(primary.sent).toHaveLength(0);
    expect(fallback.sent).toHaveLength(1);
  });

  it("an attempt past the last one fails the message", async () => {
    const { id } = await queue("late@example.test");
    expect(await sendQueued(deps(scripted("smtp")), id, 9)).toBe("failed");
    expect((await row(id)).last_error).toBe("no attempts left");
  });

  it("non-provider errors are treated as transient", async () => {
    const boom: EmailProvider = { name: "smtp", send: async () => Promise.reject(new Error("socket hang up")) };
    const { id } = await queue("boom@example.test");
    await expect(sendQueued(deps(boom), id, 1)).rejects.toThrow("socket hang up");
    expect((await row(id)).status).toBe("queued");
  });
});

describe("permanent failures and suppression", () => {
  it("a rejected recipient fails the message and suppresses the address (case-insensitively)", async () => {
    const p = scripted("smtp", [new ProviderError("EENVELOPE 550: mailbox unavailable", true, true)]);
    const first = await queue("Bounce@Example.test");
    expect(await sendQueued(deps(p), first.id, 1)).toBe("failed");
    expect(await row(first.id)).toMatchObject({
      status: "failed",
      last_error: "smtp: EENVELOPE 550: mailbox unavailable",
    });
    const sup = await s.admin.db.selectFrom("suppressions").selectAll().execute();
    expect(sup.map((x) => x.reason)).toEqual(["hard_bounce"]);
    const second = await queue("bounce@example.TEST");
    expect(await sendQueued(deps(p), second.id, 1)).toBe("suppressed");
    expect(await row(second.id)).toMatchObject({ status: "suppressed", last_error: "suppressed: hard_bounce" });
    expect(p.sent).toHaveLength(0);
  });

  it("a permanent non-recipient failure does not suppress", async () => {
    const p = scripted("smtp", [new ProviderError("EMESSAGE 554: content rejected", true, false)]);
    const { id } = await queue("content@example.test");
    expect(await sendQueued(deps(p), id, 1)).toBe("failed");
    const n = await sql<{ n: string }>`select count(*)::text as n from suppressions`.execute(s.admin.db);
    expect(n.rows[0]?.n).toBe("1");
  });

  it("a message that cannot be rendered fails without retrying", async () => {
    const { id } = await queue("broken@example.test");
    await s.admin.db
      .updateTable("messages")
      .set({ variables_enc: s.notify.cipher.encrypt('{"nope":1}', `msg:${id}:variables`) })
      .where("id", "=", id)
      .execute();
    expect(await sendQueued(deps(scripted("smtp")), id, 1)).toBe("failed");
    expect((await row(id)).last_error).toMatch(/^render: invalid variables for account.reinstated/);
    // ciphertext bound to another message (AAD) cannot be swapped in
    const other = await queue("other@example.test");
    const stolen = (await row(other.id)).variables_enc;
    const victim = await queue("victim@example.test");
    await s.admin.db.updateTable("messages").set({ variables_enc: stolen }).where("id", "=", victim.id).execute();
    expect(await sendQueued(deps(scripted("smtp")), victim.id, 1)).toBe("failed");
  });
});

describe("limits and idempotency", () => {
  it("over the hourly limit a recipient's mail is suppressed (rate_limited)", async () => {
    const p = scripted("smtp");
    const ids = [await queue("busy@example.test"), await queue("busy@example.test"), await queue("BUSY@example.test")];
    expect(await sendQueued(deps(p, { hourlyLimit: 2 }), ids[0]?.id as string, 1)).toBe("sent");
    expect(await sendQueued(deps(p, { hourlyLimit: 2 }), ids[1]?.id as string, 1)).toBe("sent");
    expect(await sendQueued(deps(p, { hourlyLimit: 2 }), ids[2]?.id as string, 1)).toBe("suppressed");
    expect((await row(ids[2]?.id as string)).last_error).toBe("rate_limited");
  });

  it("a sent or unknown message is skipped (a duplicate job never re-sends)", async () => {
    const p = scripted("smtp");
    const { id } = await queue("once@example.test");
    expect(await sendQueued(deps(p), id, 1)).toBe("sent");
    expect(await sendQueued(deps(p), id, 1)).toBe("skipped");
    expect(await sendQueued(deps(p), "018f0000-0000-7000-8000-000000000000", 1)).toBe("skipped");
    expect(p.sent).toHaveLength(1);
  });
});

describe("retention", () => {
  it("purge.messages deletes messages older than the retention", async () => {
    const { id } = await queue("old@example.test");
    await sql`update messages set created_at = now() - interval '91 days' where id = ${id}`.execute(s.admin.db);
    const recent = await queue("recent@example.test");
    const handlers = jobHandlers(
      { n: s.notify, peers: {} as never, routing: {} as never, securityContacts: [] },
      deps(scripted("smtp")),
      { retentionDays: 90 },
    );
    await handlers["purge.messages"]?.(null, {
      id: "j",
      kind: "purge.messages",
      attempt: 1,
      extendLease: async () => {},
    });
    expect(
      await s.admin.db.selectFrom("messages").select("id").where("id", "=", id).executeTakeFirst(),
    ).toBeUndefined();
    expect(
      await s.admin.db.selectFrom("messages").select("id").where("id", "=", recent.id).executeTakeFirst(),
    ).toBeDefined();
  });
});

describe("daily send cap (beta: Resend free plan)", () => {
  const capped = (limit: number, reserve: number, onCapReached?: SendDeps["onCapReached"]) => ({
    dailyCap: { limit, reserve },
    ...(onCapReached ? { onCapReached } : {}),
  });
  const resetCap = () => sql`delete from email_daily_counts`.execute(s.admin.db);
  const sentToday = async () =>
    Number(
      (
        await sql<{ n: number }>`select coalesce(max(sent), 0)::int as n from email_daily_counts
          where day = (now() at time zone 'UTC')::date`.execute(s.admin.db)
      ).rows[0]?.n,
    );

  it("counts each send; non-essential mail stops at cap − reserve and is deferred to the next UTC day", async () => {
    await resetCap();
    const p = scripted("smtp");
    const alerts: unknown[] = [];
    const d = deps(
      p,
      capped(3, 1, (i) => alerts.push(i)),
    );
    const a = await queue("cap-a@example.test", "payment.receipt");
    const b = await queue("cap-b@example.test", "payment.receipt");
    const c = await queue("cap-c@example.test", "payment.receipt");
    expect(await sendQueued(d, a.id, 1)).toBe("sent");
    expect(await sendQueued(d, b.id, 1)).toBe("sent");
    expect(await sentToday()).toBe(2);
    // the third receipt would eat the reserved slot
    expect(await sendQueued(d, c.id, 1)).toBe("deferred");
    expect(p.sent).toHaveLength(2);
    const r = await row(c.id);
    expect(r.status).toBe("queued");
    expect(r.last_error).toMatch(/^daily_cap: deferred to \d{4}-\d{2}-\d{2}T00:/);
    const job = await s.admin.db
      .selectFrom("jobs")
      .select(["run_at", "dedupe_key"])
      .where("dedupe_key", "like", `message.send:${c.id}:%`)
      .executeTakeFirstOrThrow();
    expect(new Date(job.run_at).getTime()).toBeGreaterThan(Date.now());
    expect(alerts).toHaveLength(1);
    expect(await sentToday()).toBe(2);

    // essential mail may still use the reserve, then the cap is hard
    const link = await queue("cap-link@example.test", "security.destination_activated");
    expect(await sendQueued(d, link.id, 1)).toBe("sent");
    expect(await sentToday()).toBe(3);
    const magic = await queue("cap-magic@example.test", "auth.magic_link");
    // a sign-in link would expire before tomorrow: it fails instead of waiting
    expect(await sendQueued(d, magic.id, 1)).toBe("failed");
    expect(await row(magic.id)).toMatchObject({ status: "failed", last_error: "daily_cap" });
    // the alert fires once per day
    expect(alerts).toHaveLength(1);
  });

  it("a message capped for too long fails; no cap (limit 0) never counts", async () => {
    await resetCap();
    const d = deps(scripted("smtp"), capped(1, 0));
    const first = await queue("cap-first@example.test", "payment.receipt");
    expect(await sendQueued(d, first.id, 1)).toBe("sent");
    const old = await queue("cap-old@example.test", "payment.receipt");
    await sql`update messages set created_at = now() - interval '4 days' where id = ${old.id}`.execute(s.admin.db);
    expect(await sendQueued(d, old.id, 1)).toBe("failed");
    expect(await row(old.id)).toMatchObject({ last_error: "daily_cap" });

    await resetCap();
    const free = await queue("cap-free@example.test", "payment.receipt");
    expect(await sendQueued(deps(scripted("smtp"), capped(0, 0)), free.id, 1)).toBe("sent");
    expect(await sentToday()).toBe(0);
  });

  it("concurrent sends never overshoot the cap", async () => {
    await resetCap();
    const p = scripted("smtp");
    const d = deps(p, capped(4, 0));
    const ids = await Promise.all(
      Array.from({ length: 10 }, (_, i) => queue(`cap-par-${i}@example.test`, "payment.receipt")),
    );
    const results = await Promise.all(ids.map(({ id }) => sendQueued(d, id, 1)));
    expect(results.filter((r) => r === "sent")).toHaveLength(4);
    expect(results.filter((r) => r === "deferred")).toHaveLength(6);
    expect(await sentToday()).toBe(4);
  });

  it("passes Reply-To to the provider", async () => {
    await resetCap();
    const p = scripted("smtp");
    const { id } = await queue("reply@example.test");
    expect(await sendQueued(deps(p, { replyTo: "nearpaydotmoney@gmail.com" }), id, 1)).toBe("sent");
    expect(p.sent[0]?.replyTo).toBe("nearpaydotmoney@gmail.com");
  });
});

/**
 * The `worker` end to end: NATS events → fan-out through spec-mocked identity/payments → SMTP into
 * a real Mailpit; magic links from the api; dedupe, roles, receipts, ops contacts, outages.
 */
import { sql } from "@nearpay-internal/db";
import { newId, toUuid } from "@nearpay-internal/ids";
import { getNotificationRecipients, getReceiptContext } from "@nearpay-internal/spec";
import {
  account,
  domainEvent,
  internalSettlementDestination,
  mockError,
  paymentIntent,
} from "@nearpay-internal/testing";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eventually, type Stack, startStack } from "../support/stack.js";

let s: Stack;
beforeAll(async () => {
  s = await startStack({
    worker: true,
    testModeReceipts: true,
    securityContacts: ["ops@nearpay.test", "oncall@nearpay.test"],
  });
});
afterAll(async () => {
  await s?.stop();
});

const team = (acct: string) => [
  { user_id: newId("usr"), email: `owner+${acct}@merchant.test`, role: "owner" as const },
  { user_id: newId("usr"), email: `admin+${acct}@merchant.test`, role: "admin" as const },
];
const to = (addr: string) => (m: { To: { Address: string }[] }) => m.To.some((t) => t.Address === addr);

beforeEach(() => {
  s.identity.reset();
  s.payments.reset();
  s.identity.on(getNotificationRecipients, async (ctx) => ({ recipients: team(ctx.params.id) }));
});

describe("magic links (api → worker → SMTP)", () => {
  it("delivers the link, with a stable Message-ID, and wipes the link once sent", async () => {
    const r = await s.call("POST", "/internal/messages", {
      body: {
        template: "auth.magic_link",
        to: "new.user@merchant.test",
        variables: {
          link_url: "https://dashboard.nearpay.localhost/auth/magic?token=secret1",
          purpose: "signup",
          expires_in_minutes: 15,
        },
        dedupe_key: "signup:new.user",
      },
    });
    const id = (r.body as { message_id: string }).message_id;
    const [m] = await s.mailpit.waitFor(to("new.user@merchant.test"));
    expect(m?.Subject).toBe("Confirm your email to finish signing up");
    expect(m?.From).toMatchObject({ Address: "no-reply@nearpay.money", Name: "NearPay" });
    const full = await s.mailpit.message(m?.ID as string);
    expect(full.Text).toContain("https://dashboard.nearpay.localhost/auth/magic?token=secret1");
    expect(full.HTML).toContain('href="https://dashboard.nearpay.localhost/auth/magic?token=secret1"');
    const headers = await s.mailpit.headers(m?.ID as string);
    expect(headers["Message-Id"]?.[0] ?? headers["Message-ID"]?.[0]).toBe(`<${toUuid(id, "msg")}@nearpay.money>`);
    expect(headers["Auto-Submitted"]?.[0]).toBe("auto-generated");
    const row = await eventually(async () => {
      const x = await s.admin.db
        .selectFrom("messages")
        .selectAll()
        .where("id", "=", toUuid(id, "msg"))
        .executeTakeFirstOrThrow();
      return x.status === "sent" ? x : null;
    });
    expect(row).toMatchObject({ provider: "smtp", attempts: 1, last_error: null });
    expect(row.sent_at).not.toBeNull();
    expect(s.notify.cipher.decrypt(row.variables_enc, `msg:${row.id}:variables`).toString()).toBe("{}");
  });
});

describe("account events", () => {
  it("welcomes only the owner, once, even when the event is redelivered", async () => {
    const a = account({ display_name: "Shop One" });
    const e = domainEvent("evt.identity.account.created", a, { accountUuid: toUuid(a.id, "acct") });
    await s.publishEvent(e);
    await s.publishEvent({ ...e }); // JetStream dedupes the msg id
    const { publish } = await import("@nearpay-internal/bus");
    await publish(s.bus as never, e.subject, e, `${e.id}-again`); // and the inbox the event id
    const [m] = await s.mailpit.waitFor(to(`owner+${a.id}@merchant.test`));
    expect(m?.Subject).toBe("Welcome to NearPay");
    expect((await s.mailpit.message(m?.ID as string)).Text).toContain("Welcome, Shop One");
    await new Promise((r) => setTimeout(r, 500));
    expect((await s.mailpit.messages()).filter(to(`owner+${a.id}@merchant.test`))).toHaveLength(1);
    expect((await s.mailpit.messages()).filter(to(`admin+${a.id}@merchant.test`))).toHaveLength(0);
    const call = s.identity.callsTo(getNotificationRecipients)[0];
    expect(call?.query).toEqual({ kind: "security" });
    expect(call?.principal).toMatchObject({ ptype: "service", sub: "notify" });
  });

  it("security alerts go to owners and admins with the fingerprint", async () => {
    const d = internalSettlementDestination({ status: "cooling_off", active_at: 1_800_000_000 });
    await s.publishEvent(domainEvent("evt.identity.settlement_destination.cooling_off", d));
    const ms = await s.mailpit.waitFor(
      (m) => to(`owner+${d.account}@merchant.test`)(m) || to(`admin+${d.account}@merchant.test`)(m),
      2,
    );
    for (const m of ms) {
      expect(m.Subject).toBe("Security alert: a new settlement destination was added");
      const body = await s.mailpit.message(m.ID);
      expect(body.Text).toContain(d.fingerprint);
      expect(body.Text).toContain("2027-01-15 08:00 UTC");
    }
  });

  it("KYB decisions reach owners; compliance reasons other than needs_info are never shown", async () => {
    const acct = newId("acct");
    const ev = (status: "approved" | "rejected" | "needs_info", reason: string) =>
      domainEvent(
        `evt.compliance.kyb.${status}`,
        { account_id: acct, status, reason },
        { accountUuid: toUuid(acct, "acct"), livemode: null },
      );
    await s.publishEvent(ev("rejected", "INTERNAL: adverse media"));
    await s.publishEvent(ev("needs_info", "Please upload the registry extract"));
    const ms = await s.mailpit.waitFor(to(`owner+${acct}@merchant.test`), 2);
    const bodies = await Promise.all(ms.map((m) => s.mailpit.message(m.ID)));
    expect(bodies.map((b) => b.Subject).sort()).toEqual([
      "We need more information to verify your business",
      "Your business verification was not approved",
    ]);
    expect(bodies.some((b) => b.Text.includes("Please upload the registry extract"))).toBe(true);
    expect(bodies.some((b) => b.Text.includes("adverse media"))).toBe(false);
  });

  it("an unknown account sends nothing and does not retry", async () => {
    s.identity.on(getNotificationRecipients, async (ctx) =>
      mockError("resource_missing", { params: { object: "account", id: ctx.params.id } }),
    );
    const acct = newId("acct");
    const e = domainEvent("evt.compliance.account.suspended", { account_id: acct, reason: "x" }, { livemode: null });
    await s.publishEvent(e);
    await eventually(async () => {
      const j = await sql<{ done_at: Date | null; attempts: number }>`
        select done_at, attempts from jobs where dedupe_key = ${`event.notify:${e.id}`}`.execute(s.admin.db);
      return j.rows[0]?.done_at ? j.rows[0] : null;
    });
    expect(
      await s.admin.db.selectFrom("messages").select("id").where("account_id", "=", toUuid(acct, "acct")).execute(),
    ).toEqual([]);
  });

  it("an identity outage delays the mail; it is sent once identity recovers", async () => {
    let calls = 0;
    s.identity.on(getNotificationRecipients, async (ctx) => {
      calls++;
      // the http client retries a GET 3 times: fail all of them so the job itself backs off (~10 s)
      if (calls <= 3) mockError("api_error");
      return { recipients: team(ctx.params.id) };
    });
    const acct = newId("acct");
    await s.publishEvent(
      domainEvent("evt.compliance.account.reinstated", { account_id: acct, reason: "x" }, { livemode: null }),
    );
    await s.mailpit.waitFor(to(`owner+${acct}@merchant.test`), 1, 40_000);
    expect(calls).toBe(4);
  }, 60_000);
});

describe("payment receipts", () => {
  it("sends the receipt to the customer with amount, fingerprint and proof", async () => {
    const pi = paymentIntent({ livemode: true, status: "succeeded" });
    s.payments.on(getReceiptContext, async () => ({
      customer_email: "buyer@example.test",
      merchant_display_name: "Acme <Shop>",
      amount: 2500,
      currency: "usd",
      settled: { amount: "25000000", asset_id: pi.destination.asset_id, decimals: 6, display: "25.00 USDC (NEAR)" },
      evidence_links: ["https://nearblocks.io/txns/8Ld3Ap4zR2yK7uR3nVbXq1sH4cW9tE6mP2fJ5gD1aB7c"],
      email_receipts: true,
    }));
    await s.publishEvent(domainEvent("evt.payments.payment_intent.succeeded", pi, { livemode: true }));
    const [m] = await s.mailpit.waitFor(to("buyer@example.test"));
    expect(m?.Subject).toBe("Your receipt from Acme <Shop>");
    const body = await s.mailpit.message(m?.ID as string);
    expect(body.Text).toContain("Amount: 25.00 USD");
    expect(body.Text).toMatch(/Paid to \(fingerprint\): [0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{2}/);
    expect(body.HTML).toContain("Acme &lt;Shop&gt;");
    expect(s.payments.callsTo(getReceiptContext)[0]?.params).toEqual({ id: pi.id });
  });

  it("skips accounts with receipts off and sessions without an email", async () => {
    const off = paymentIntent({ livemode: true, status: "succeeded" });
    const noEmail = paymentIntent({ livemode: true, status: "succeeded" });
    s.payments.on(getReceiptContext, async (ctx) => ({
      customer_email: ctx.params.id === off.id ? "never@example.test" : null,
      merchant_display_name: "X",
      amount: 100,
      currency: "usd",
      settled: { amount: "1000000", asset_id: off.destination.asset_id, decimals: 6, display: "1.00 USDC" },
      evidence_links: [],
      email_receipts: ctx.params.id !== off.id,
    }));
    const events = [off, noEmail].map((pi) =>
      domainEvent("evt.payments.payment_intent.succeeded", pi, { livemode: true }),
    );
    for (const e of events) await s.publishEvent(e);
    await eventually(async () => {
      const r = await sql<{
        n: string;
      }>`select count(*)::text as n from jobs where kind = 'event.notify' and done_at is not null
        and dedupe_key in (${sql.join(events.map((e) => `event.notify:${e.id}`))})`.execute(s.admin.db);
      return Number(r.rows[0]?.n) === 2;
    });
    expect((await s.mailpit.messages()).filter(to("never@example.test"))).toEqual([]);
  });

  it("test-mode receipts say so (enabled in this stack, like local Compose)", async () => {
    const pi = paymentIntent({ livemode: false, status: "succeeded" });
    s.payments.on(getReceiptContext, async () => ({
      customer_email: "test.buyer@example.test",
      merchant_display_name: "Acme",
      amount: 500,
      currency: "eur",
      settled: { amount: "5000000", asset_id: pi.destination.asset_id, decimals: 6, display: "5.00 USDC" },
      evidence_links: [],
      email_receipts: true,
    }));
    await s.publishEvent(domainEvent("evt.payments.payment_intent.succeeded", pi, { livemode: false }));
    const [m] = await s.mailpit.waitFor(to("test.buyer@example.test"));
    expect(m?.Subject).toBe("Your receipt from Acme [test]");
  });
});

describe("ops alerts", () => {
  it("kill switch changes go to every security contact", async () => {
    const reason = `stop ${Math.random()}`;
    await s.publishEvent(
      domainEvent(
        "evt.sentinel.kill_switch.engaged",
        { engaged: true, reason, actor: "sentinel" },
        { accountUuid: null, livemode: null },
      ),
    );
    const ms = await s.mailpit.waitFor(
      (m) =>
        m.Subject === "[NearPay ops] Kill switch ENGAGED" &&
        (to("ops@nearpay.test")(m) || to("oncall@nearpay.test")(m)),
      2,
    );
    expect(ms).toHaveLength(2);
  });

  it("a passing audit finding sends nothing (no job at all)", async () => {
    const f = {
      id: newId("fnd"),
      execution_id: newId("ex"),
      account_id: newId("acct"),
      livemode: true,
      check_kind: "k",
      result: "pass",
      details: {},
    };
    const e = domainEvent("evt.sentinel.audit_finding.created", f, { livemode: true });
    await s.publishEvent(e);
    await eventually(
      async () =>
        (await s.admin.db.selectFrom("inbox").select("event_id").where("event_id", "=", e.id).execute()).length === 1,
    );
    const jobs = await sql`select id from jobs where dedupe_key = ${`event.notify:${e.id}`}`.execute(s.admin.db);
    expect(jobs.rows).toEqual([]);
  });
});

describe("metrics", () => {
  it("counts messages and exports the queue depth", async () => {
    const text = await (await fetch(`http://127.0.0.1:${s.worker?.metricsPort}/metrics`)).text();
    expect(text).toMatch(/nearpay_notify_messages_total\{template="auth.magic_link",status="sent"\} \d+/);
    expect(text).toMatch(/^nearpay_notify_messages_queued \d+$/m);
    expect(text).toMatch(/nearpay_notify_send_duration_seconds_count\{provider="smtp"\} \d+/);
    expect(text).toMatch(/nearpay_notify_consumer_lag_messages\{durable="notify--EVT_IDENTITY"\}/);
  });
});

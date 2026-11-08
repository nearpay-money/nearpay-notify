/**
 * Billing mails end to end (step 3.2): `evt.billing.*` on NATS → `event.notify` → spec-mocked billing
 * (and payments for the paid receipt) → SMTP into a real Mailpit. Recipient resolution, the
 * fail-closed checks, idempotent sends, the wiped hosted link and logs without the invoice secret.
 */
import { publish } from "@nearpay-internal/bus";
import { sql } from "@nearpay-internal/db";
import { toUuid } from "@nearpay-internal/ids";
import {
  getInvoiceNotificationContext,
  getReceiptContext,
  getSubscriptionNotificationContext,
} from "@nearpay-internal/spec";
import { domainEvent, mockError, paymentIntent } from "@nearpay-internal/testing";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Notify } from "../../src/app/context.js";
import {
  type InvoiceCtx,
  invoice,
  invoiceContext,
  reminderEvent,
  subscription,
  subscriptionContext,
} from "../support/billing.js";
import { eventually, type Stack, startStack } from "../support/stack.js";

let s: Stack;
/** Everything notify logs (its own logger: fan-out, send job), to prove the invoice secret never appears. */
const logged: string[] = [];

function recorder(bindings: object = {}): Notify["log"] {
  return new Proxy({} as Notify["log"], {
    get: (_t, k) =>
      k === "child"
        ? (b: object) => recorder({ ...bindings, ...b })
        : (...args: unknown[]) => {
            logged.push(
              JSON.stringify([bindings, ...args], (_key, v) =>
                v instanceof Error ? { message: v.message, stack: v.stack } : v,
              ),
            );
          },
  });
}

beforeAll(async () => {
  s = await startStack({ worker: true, testModeReceipts: true });
  (s.worker?.notify as { log: Notify["log"] }).log = recorder();
});
afterAll(async () => {
  await s?.stop();
  // no line notify logged during the whole suite carries an invoice secret
  expect(logged.length).toBeGreaterThan(0);
  expect(logged.filter((l) => l.includes("isec_"))).toEqual([]);
});
beforeEach(() => {
  s.billing.reset();
  s.payments.reset();
});

const to = (addr: string) => (m: { To: { Address: string }[] }) => m.To.some((t) => t.Address === addr);
let n = 0;
const customer = () => `customer${++n}@billing.test`;

async function jobDone(eventId: string) {
  return eventually(async () => {
    const j = await sql<{ done_at: Date | null }>`
      select done_at from jobs where dedupe_key = ${`event.notify:${eventId}`}`.execute(s.admin.db);
    return j.rows[0]?.done_at ? true : null;
  }, 20_000);
}

const messagesOf = (eventId: string) =>
  s.admin.db.selectFrom("messages").selectAll().where("dedupe_key", "like", `%:${eventId}:%`).execute();

function serveInvoice(ctx: InvoiceCtx) {
  s.billing.on(getInvoiceNotificationContext, async (c) => {
    if (c.params.id !== ctx.invoice) mockError("resource_missing", { params: { object: "invoice", id: c.params.id } });
    return ctx;
  });
}

describe("invoice.issued", () => {
  it("mails the customer the invoice with its hosted link, once, and wipes the link at rest", async () => {
    const email = customer();
    const inv = invoice({ livemode: true });
    const ctx = invoiceContext({ invoice: inv.id, customer_email: email });
    serveInvoice(ctx);
    const e = domainEvent("evt.billing.invoice.sent", inv, { livemode: true });
    await s.publishEvent(e);
    // a redelivery under another NATS message id is caught by the inbox (INV-4)
    if (s.bus) await publish(s.bus, e.subject, e, `${e.id}-redelivered`);

    const [m] = await s.mailpit.waitFor(to(email));
    expect(m?.Subject).toBe("Invoice ACMESH-L-00042 from Acme Test Shop");
    const body = await s.mailpit.message(m?.ID as string);
    expect(body.Text).toContain(`View and pay invoice: ${ctx.hosted_invoice_url}`);
    expect(body.Text).toContain("Amount due: 108.90 USD");
    expect(body.Text).toContain("Tax: 9.90 USD");
    expect(body.HTML).toContain(`href="${ctx.hosted_invoice_url}"`);
    expect(s.billing.callsTo(getInvoiceNotificationContext)[0]?.params).toEqual({ id: inv.id });

    const row = await eventually(async () => {
      const [r] = await messagesOf(e.id);
      return r?.status === "sent" ? r : null;
    });
    expect(row).toMatchObject({
      template: "invoice.issued",
      dedupe_key: `invoice.issued:${e.id}:customer`,
      source: "event:evt.billing.invoice.sent",
      account_id: toUuid(ctx.account_id, "acct"),
      livemode: true,
    });
    expect(s.notify.cipher.decrypt(row.variables_enc, `msg:${row.id}:variables`).toString()).toBe("{}");
    await new Promise((r) => setTimeout(r, 500));
    expect((await s.mailpit.messages()).filter(to(email))).toHaveLength(1);
    expect(await messagesOf(e.id)).toHaveLength(1);
  });

  it("sends nothing when the invoice was voided meanwhile, the modes differ, or no email is on record", async () => {
    const voided = invoice();
    const otherMode = invoice();
    const noEmail = invoice();
    const byId = new Map<string, InvoiceCtx>(
      [
        invoiceContext({ invoice: voided.id, status: "void", hosted_invoice_url: null }),
        invoiceContext({ invoice: otherMode.id, livemode: false }),
        invoiceContext({ invoice: noEmail.id, customer_email: null }),
      ].map((c) => [c.invoice, c]),
    );
    s.billing.on(getInvoiceNotificationContext, async (c) => byId.get(c.params.id) as InvoiceCtx);
    for (const inv of [voided, otherMode, noEmail]) {
      const e = domainEvent("evt.billing.invoice.sent", inv, { livemode: true });
      await s.publishEvent(e);
      await jobDone(e.id);
      expect(await messagesOf(e.id)).toEqual([]);
    }
  });

  it("an unknown invoice sends nothing; a billing outage only delays the mail", async () => {
    const unknown = invoice();
    s.billing.on(getInvoiceNotificationContext, async (c) =>
      mockError("resource_missing", { params: { object: "invoice", id: c.params.id } }),
    );
    const e1 = domainEvent("evt.billing.invoice.sent", unknown, { livemode: true });
    await s.publishEvent(e1);
    await jobDone(e1.id);
    expect(await messagesOf(e1.id)).toEqual([]);

    const email = customer();
    const inv = invoice();
    const ctx = invoiceContext({ invoice: inv.id, customer_email: email });
    let calls = 0;
    s.billing.on(getInvoiceNotificationContext, async () => {
      calls++;
      // the http client retries a GET 3 times: fail them all so the job itself backs off
      if (calls <= 3) mockError("api_error");
      return ctx;
    });
    await s.publishEvent(domainEvent("evt.billing.invoice.sent", inv, { livemode: true }));
    await s.mailpit.waitFor(to(email), 1, 40_000);
    expect(calls).toBe(4);
  }, 60_000);
});

describe("invoice.reminder", () => {
  it("reads the context with ?reminder= and mails the reminder", async () => {
    const email = customer();
    const r = reminderEvent({ number: 2, offset_days: 0 });
    const ctx = invoiceContext({
      invoice: r.invoice,
      customer_email: email,
      reminder: { number: 2, offset_days: 0, last: false },
    });
    serveInvoice(ctx);
    const e = domainEvent("evt.billing.invoice.reminder", r, { livemode: true });
    await s.publishEvent(e);
    const [m] = await s.mailpit.waitFor(to(email));
    expect(m?.Subject).toBe("Invoice ACMESH-L-00042 from Acme Test Shop is due today");
    expect(s.billing.callsTo(getInvoiceNotificationContext)[0]?.query).toMatchObject({ reminder: 2 });
    expect((await s.mailpit.message(m?.ID as string)).Text).toContain(`Pay invoice: ${ctx.hosted_invoice_url}`);
  });

  it("a reminder for an invoice paid meanwhile sends nothing", async () => {
    const r = reminderEvent({ number: 1, offset_days: -3 });
    serveInvoice(invoiceContext({ invoice: r.invoice, status: "paid", amount_remaining: 0 }));
    const e = domainEvent("evt.billing.invoice.reminder", r, { livemode: true });
    await s.publishEvent(e);
    await jobDone(e.id);
    expect(await messagesOf(e.id)).toEqual([]);
  });

  it("a test-mode reminder says so", async () => {
    const email = customer();
    const r = reminderEvent({ number: 5, offset_days: 7, last: true });
    serveInvoice(invoiceContext({ invoice: r.invoice, livemode: false, customer_email: email }));
    await s.publishEvent(domainEvent("evt.billing.invoice.reminder", r, { livemode: false }));
    const [m] = await s.mailpit.waitFor(to(email));
    expect(m?.Subject).toBe("Overdue: invoice ACMESH-L-00042 from Acme Test Shop [test]");
    const text = (await s.mailpit.message(m?.ID as string)).Text;
    expect(text).toContain("Test mode");
    expect(text).toContain("This is the last reminder for this invoice.");
  });
});

describe("invoice.paid and invoice.voided", () => {
  it("confirms the payment with the settlement and on-chain proof from payments", async () => {
    const email = customer();
    const pi = paymentIntent({ livemode: true, status: "succeeded" });
    const inv = invoice({ status: "paid", amount_paid: 10890, amount_remaining: 0, payment_intent: pi.id });
    serveInvoice(
      invoiceContext({
        invoice: inv.id,
        customer_email: email,
        status: "paid",
        amount_remaining: 0,
        payment_intent: pi.id,
      }),
    );
    s.payments.on(getReceiptContext, async () => ({
      customer_email: email,
      merchant_display_name: "Acme Test Shop",
      amount: 10890,
      currency: "usd",
      settled: { amount: "108900000", asset_id: pi.destination.asset_id, decimals: 6, display: "108.90 USDC (NEAR)" },
      evidence_links: ["https://nearblocks.io/txns/8Ld3Ap4zR2yK7uR3nVbXq1sH4cW9tE6mP2fJ5gD1aB7c"],
      email_receipts: true,
    }));
    await s.publishEvent(domainEvent("evt.billing.invoice.paid", inv, { livemode: true }));
    const [m] = await s.mailpit.waitFor(to(email));
    expect(m?.Subject).toBe("Payment received: invoice ACMESH-L-00042 from Acme Test Shop");
    const text = (await s.mailpit.message(m?.ID as string)).Text;
    expect(text).toContain("Amount paid: 108.90 USD");
    expect(text).toContain("Settled: 108.90 USDC (NEAR)");
    expect(text).toContain("https://nearblocks.io/txns/8Ld3Ap4zR2yK7uR3nVbXq1sH4cW9tE6mP2fJ5gD1aB7c");
    expect(s.payments.callsTo(getReceiptContext)[0]?.params).toEqual({ id: pi.id });
  });

  it("the invoice's payment intent sends no second receipt", async () => {
    const pi = { ...paymentIntent({ livemode: true, status: "succeeded" }), source: "invoice", invoice: invoice().id };
    const e = domainEvent("evt.payments.payment_intent.succeeded", pi, { livemode: true });
    await s.publishEvent(e);
    await new Promise((r) => setTimeout(r, 1_000));
    // skipped in the consumer: no job, no message, no payments call
    const j = await sql`select 1 from jobs where dedupe_key = ${`event.notify:${e.id}`}`.execute(s.admin.db);
    expect(j.rows).toEqual([]);
    expect(s.payments.callsTo(getReceiptContext)).toEqual([]);
  });

  it("tells the customer a voided invoice needs no payment, without the payment link", async () => {
    const email = customer();
    const inv = invoice({ status: "void" });
    serveInvoice(invoiceContext({ invoice: inv.id, customer_email: email, status: "void", hosted_invoice_url: null }));
    await s.publishEvent(domainEvent("evt.billing.invoice.voided", inv, { livemode: true }));
    const [m] = await s.mailpit.waitFor(to(email));
    expect(m?.Subject).toBe("Invoice ACMESH-L-00042 from Acme Test Shop was voided");
    const body = await s.mailpit.message(m?.ID as string);
    expect(body.Text).toContain("You do not need to pay it");
    expect(body.Text).not.toContain("pay.nearpay.localhost");
  });
});

describe("subscription.renewal_upcoming", () => {
  it("tells the customer when the subscription renews and what the invoice will be", async () => {
    const email = customer();
    const sub = subscription();
    s.billing.on(getSubscriptionNotificationContext, async () =>
      subscriptionContext({ subscription: sub.id, customer_email: email }),
    );
    await s.publishEvent(domainEvent("evt.billing.subscription.renewal_upcoming", sub, { livemode: true }));
    const [m] = await s.mailpit.waitFor(to(email));
    expect(m?.Subject).toBe("Your Acme Test Shop subscription renews on 1 Dec 2026");
    expect((await s.mailpit.message(m?.ID as string)).Text).toContain("Next invoice: 108.90 USD");
    expect(s.billing.callsTo(getSubscriptionNotificationContext)[0]?.params).toEqual({ id: sub.id });
  });

  it("sends nothing for a subscription canceled meanwhile", async () => {
    const sub = subscription();
    s.billing.on(getSubscriptionNotificationContext, async () =>
      subscriptionContext({ subscription: sub.id, status: "canceled" }),
    );
    const e = domainEvent("evt.billing.subscription.renewal_upcoming", sub, { livemode: true });
    await s.publishEvent(e);
    await jobDone(e.id);
    expect(await messagesOf(e.id)).toEqual([]);
  });
});

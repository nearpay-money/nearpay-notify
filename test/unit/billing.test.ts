/** Billing mails (lld/notify.md §4, step 3.2): routing, context checks, variables, copy. */
import { BILLING_EMAIL_TEMPLATES } from "@nearpay-internal/spec";
import { domainEvent, paymentIntent } from "@nearpay-internal/testing";
import { describe, expect, it } from "vitest";
import { createRenderer } from "../../src/app/render.js";
import { CREDENTIAL_TEMPLATES } from "../../src/app/send.js";
import { INVOICE_STATUS_FITS, invoiceMail, renewalMail } from "../../src/domain/message/billing.js";
import { INVOICE_TEMPLATES, planFor, type RoutedEvent, type RoutingOptions } from "../../src/domain/message/routing.js";
import { LinkError, safeHref } from "../../src/domain/template/blocks.js";
import {
  formatAmount,
  formatDay,
  formatInterval,
  parseVariables,
  renderContent,
} from "../../src/domain/template/catalogue.js";
import { SAMPLES } from "../../src/domain/template/samples.js";
import { invoice, invoiceContext, reminderEvent, subscription, subscriptionContext } from "../support/billing.js";

const o: RoutingOptions = {
  dashboardOrigin: "https://dashboard.nearpay.localhost",
  consoleOrigin: "https://ops.nearpay.localhost",
  testModeReceipts: false,
  chainName: (c) => c,
  fingerprint: () => "FP",
};
const ev = (subject: string, object: object, livemode: boolean | null = true): RoutedEvent => ({
  id: "0193b0c0-0000-7000-8000-000000000001",
  subject,
  livemode,
  data: { object },
});
const plan = (e: RoutedEvent, opts = o) => {
  const r = planFor(e, opts);
  if (!("plan" in r)) throw new Error(`skipped: ${r.skip}`);
  return r.plan;
};
const skip = (e: RoutedEvent, opts = o) => {
  const r = planFor(e, opts);
  if ("plan" in r) throw new Error("expected a skip");
  return r.skip;
};

describe("routing (spec BILLING_EMAIL_TEMPLATES)", () => {
  it("maps every billing template's subject to that template", () => {
    for (const [template, { subject }] of Object.entries(BILLING_EMAIL_TEMPLATES)) {
      if (subject === "evt.billing.subscription.renewal_upcoming") {
        expect(template).toBe("subscription.renewal_upcoming");
        continue;
      }
      expect(INVOICE_TEMPLATES[subject as keyof typeof INVOICE_TEMPLATES]).toBe(template);
    }
    expect(Object.keys(INVOICE_TEMPLATES).length + 1).toBe(Object.keys(BILLING_EMAIL_TEMPLATES).length);
  });
  it("invoice.sent → invoice.issued for the invoice's customer; no secret or PII in the plan", () => {
    const i = invoice();
    const p = plan(ev("evt.billing.invoice.sent", i));
    expect(p).toEqual({
      template: "invoice.issued",
      audience: { kind: "invoice_customer", invoiceId: i.id, reminder: null },
      variables: {},
      accountId: null,
      livemode: true,
    });
  });
  it("a reminder reads the context for its number and carries the event's schedule as fallback", () => {
    const r = reminderEvent({ number: 3, offset_days: 1, last: true });
    const p = plan(ev("evt.billing.invoice.reminder", r));
    expect(p.template).toBe("invoice.reminder");
    expect(p.audience).toEqual({ kind: "invoice_customer", invoiceId: r.invoice, reminder: 3 });
    expect(p.variables).toEqual({ reminder: { number: 3, offset_days: 1, last: true } });
  });
  it("paid and voided carry when it happened", () => {
    const paidAt = 1_794_000_000;
    const paid = invoice({
      status: "paid",
      status_transitions: {
        finalized_at: 1,
        sent_at: null,
        paid_at: paidAt,
        voided_at: null,
        marked_uncollectible_at: null,
      },
    });
    expect(plan(ev("evt.billing.invoice.paid", paid)).variables).toEqual({
      paid_at: new Date(paidAt * 1000).toISOString(),
    });
    expect(plan(ev("evt.billing.invoice.voided", invoice({ status: "void" }))).variables).toEqual({ voided_at: null });
  });
  it("renewal notices go to the subscription's customer unless it cancels at the period end", () => {
    const s = subscription();
    expect(plan(ev("evt.billing.subscription.renewal_upcoming", s)).audience).toEqual({
      kind: "subscription_customer",
      subscriptionId: s.id,
    });
    expect(skip(ev("evt.billing.subscription.renewal_upcoming", subscription({ cancel_at_period_end: true })))).toMatch(
      /period end/,
    );
  });
  it("test-mode billing mails follow NP_TEST_MODE_RECEIPTS", () => {
    for (const [subject, object] of [
      ["evt.billing.invoice.sent", invoice({ livemode: false })],
      ["evt.billing.invoice.reminder", reminderEvent()],
      ["evt.billing.subscription.renewal_upcoming", subscription({ livemode: false })],
    ] as const) {
      expect(skip(ev(subject, object, false))).toMatch(/test-mode/);
      expect(plan(ev(subject, object, false), { ...o, testModeReceipts: true }).livemode).toBe(false);
    }
  });
  it("an invoice payment sends no payment.receipt (invoice.paid replaces it)", () => {
    const pi = paymentIntent({ status: "succeeded" });
    expect(skip(ev("evt.payments.payment_intent.succeeded", { ...pi, source: "invoice" }))).toMatch(/invoice/);
    expect(skip(ev("evt.payments.payment_intent.succeeded", { ...pi, invoice: "in_x" }))).toMatch(/invoice/);
    expect(plan(domainEvent("evt.payments.payment_intent.succeeded", pi, { livemode: true })).template).toBe(
      "payment.receipt",
    );
  });
});

describe("invoiceMail (fails closed)", () => {
  const go = (
    template: Parameters<typeof invoiceMail>[0],
    ctx = invoiceContext(),
    extra: Partial<Parameters<typeof invoiceMail>[2]> = {},
  ) => invoiceMail(template, ctx, { invoiceId: ctx.invoice, livemode: ctx.livemode, variables: {}, ...extra });

  it("mails the customer the context's data and link", () => {
    const ctx = invoiceContext();
    const m = go("invoice.issued", ctx);
    if ("skip" in m) throw new Error(m.skip);
    expect(m.to).toBe("dana@customer.test");
    expect(m.accountId).toBe(ctx.account_id);
    expect(m.variables).toMatchObject({
      invoice_id: ctx.invoice,
      merchant_name: "Acme Test Shop",
      hosted_invoice_url: ctx.hosted_invoice_url,
      total: 10890,
      currency: "usd",
      asset: null,
    });
    expect(() => parseVariables("invoice.issued", m.variables)).not.toThrow();
  });
  it("skips when billing answered for another invoice", () => {
    const ctx = invoiceContext();
    expect(invoiceMail("invoice.issued", ctx, { invoiceId: "in_other", livemode: true, variables: {} })).toEqual({
      skip: "billing answered for another invoice",
    });
  });
  it("skips when the modes differ (also a platform event without mode)", () => {
    const ctx = invoiceContext({ livemode: false });
    for (const livemode of [true, null])
      expect(invoiceMail("invoice.issued", ctx, { invoiceId: ctx.invoice, livemode, variables: {} })).toEqual({
        skip: "billing reports another mode",
      });
  });
  it("skips without a customer email", () => {
    expect(go("invoice.issued", invoiceContext({ customer_email: null }))).toEqual({
      skip: "the customer has no email on record",
    });
  });
  it("skips when the status no longer fits the mail", () => {
    for (const [template, fits] of Object.entries(INVOICE_STATUS_FITS))
      for (const status of ["draft", "open", "paid", "void", "uncollectible"]) {
        const r = go(
          template as keyof typeof INVOICE_STATUS_FITS,
          invoiceContext({ status, reminder: { number: 1, offset_days: 0, last: false } }),
        );
        expect("skip" in r ? "skip" : "mail", `${template} ${status}`).toBe(fits.includes(status) ? "mail" : "skip");
      }
  });
  it("issued and reminder mails need the hosted link", () => {
    for (const t of ["invoice.issued", "invoice.reminder"] as const)
      expect(
        go(t, invoiceContext({ hosted_invoice_url: null, reminder: { number: 1, offset_days: 0, last: false } })),
      ).toEqual({
        skip: "billing returned no hosted invoice link",
      });
  });
  it("a reminder prefers the context's reminder block, else the event's, else skips", () => {
    const ctx = invoiceContext({ reminder: { number: 2, offset_days: 0, last: false } });
    const fromCtx = go("invoice.reminder", ctx, { variables: { reminder: { number: 9, offset_days: 9, last: true } } });
    expect("skip" in fromCtx ? null : fromCtx.variables.reminder).toEqual({ number: 2, offset_days: 0, last: false });
    const fromEvent = go("invoice.reminder", invoiceContext(), {
      variables: { reminder: { number: 3, offset_days: 1, last: true } },
    });
    expect("skip" in fromEvent ? null : fromEvent.variables.reminder).toEqual({
      number: 3,
      offset_days: 1,
      last: true,
    });
    expect(go("invoice.reminder", invoiceContext())).toEqual({ skip: "no reminder details" });
  });
  it("paid mails carry the receipt's settlement and proof", () => {
    const ctx = invoiceContext({
      status: "paid",
      amount_remaining: 0,
      payment_intent: "pi_01m6pm3ppnengb0aaefsa11e3j",
    });
    const m = go("invoice.paid", ctx, {
      receipt: { settled_display: "108.90 USDC (NEAR)", evidence_links: ["https://nearblocks.io/txns/abc"] },
    });
    if ("skip" in m) throw new Error(m.skip);
    expect(m.variables).toMatchObject({
      payment_id: ctx.payment_intent,
      settled_display: "108.90 USDC (NEAR)",
      evidence_links: ["https://nearblocks.io/txns/abc"],
    });
    const bare = go("invoice.paid", ctx);
    expect("skip" in bare ? null : bare.variables).toMatchObject({ settled_display: null, evidence_links: [] });
  });
  it("the voided mail never carries the hosted link", () => {
    const ctx = invoiceContext({ status: "void" });
    const m = go("invoice.voided", ctx, { variables: { voided_at: null } });
    if ("skip" in m) throw new Error(m.skip);
    const v = parseVariables("invoice.voided", m.variables);
    expect(JSON.stringify(v)).not.toContain("isec_");
  });
  it("asset invoices carry the asset's display data", () => {
    const ctx = invoiceContext({
      currency: "asset",
      asset_id: "nep141:usdc.near",
      pricing_asset: { asset_id: "nep141:usdc.near", symbol: "USDC", decimals: 6 },
      total: "1250000000",
      amount_due: "1250000000",
      amount_remaining: "1250000000",
      lines: [{ description: "Workshop", quantity: 1, amount: "1250000000" }],
    });
    const m = go("invoice.issued", ctx);
    if ("skip" in m) throw new Error(m.skip);
    expect(m.variables.asset).toEqual({ symbol: "USDC", decimals: 6 });
    expect(renderContent("invoice.issued", m.variables).preheader).toBe("1250.00 USDC due by 15 Nov 2026.");
  });
});

describe("renewalMail", () => {
  const go = (ctx = subscriptionContext(), livemode: boolean | null = true) =>
    renewalMail(ctx, { subscriptionId: ctx.subscription, livemode, variables: {} });
  it("mails the customer the next renewal", () => {
    const m = go();
    if ("skip" in m) throw new Error(m.skip);
    expect(m.variables).toMatchObject({ trialing: false, interval: "month", interval_count: 1, next_amount: 10890 });
    expect(() => parseVariables("subscription.renewal_upcoming", m.variables)).not.toThrow();
  });
  it("fails closed", () => {
    const ctx = subscriptionContext();
    expect(renewalMail(ctx, { subscriptionId: "sub_x", livemode: true, variables: {} })).toEqual({
      skip: "billing answered for another subscription",
    });
    expect(go(subscriptionContext({ livemode: false }))).toEqual({ skip: "billing reports another mode" });
    expect(go(subscriptionContext({ customer_email: null }))).toEqual({ skip: "the customer has no email on record" });
    expect(go(subscriptionContext({ cancel_at_period_end: true }))).toEqual({
      skip: "the subscription ends at the period end",
    });
    for (const status of ["canceled", "unpaid", "incomplete"])
      expect(go(subscriptionContext({ status }))).toEqual({ skip: `the subscription is ${status}` });
    for (const status of ["active", "trialing", "past_due"])
      expect("skip" in go(subscriptionContext({ status }))).toBe(false);
  });
});

describe("billing variables and copy", () => {
  const issued = SAMPLES["invoice.issued"][0];
  it("refuses fiat/asset mix-ups (INV-5: never format one as the other)", () => {
    expect(() => parseVariables("invoice.issued", { ...issued, currency: "asset", asset: null })).toThrow(/asset/);
    expect(() => parseVariables("invoice.issued", { ...issued, total: "10890" })).toThrow(/total/);
    expect(() =>
      parseVariables("invoice.issued", {
        ...issued,
        currency: "asset",
        asset: { symbol: "USDC", decimals: 6 },
        total: "1",
        amount_due: "1",
        amount_remaining: "1",
        lines: [{ description: "x", quantity: 1, amount: 1 }],
      }),
    ).toThrow(/lines\.0\.amount/);
    expect(() =>
      parseVariables("subscription.renewal_upcoming", {
        ...SAMPLES["subscription.renewal_upcoming"][0],
        next_amount: 1.5,
      }),
    ).toThrow();
  });
  it("refuses non-http links", () => {
    expect(() => parseVariables("invoice.issued", { ...issued, hosted_invoice_url: "javascript:alert(1)" })).toThrow();
  });
  it("formats integer amounts exactly", () => {
    expect(formatAmount(10890, "usd", null)).toBe("108.90 USD");
    expect(formatAmount(1200, "jpy", null)).toBe("1200 JPY");
    expect(formatAmount("1250000000", "asset", { symbol: "USDC", decimals: 6 })).toBe("1250.00 USDC");
    expect(formatAmount("1000000000000000000000001", "asset", { symbol: "NEAR", decimals: 24 })).toBe(
      "1.000000000000000000000001 NEAR",
    );
    expect(formatAmount("5", "asset", { symbol: "X", decimals: 0 })).toBe("5 X");
    expect(() => formatAmount("5", "asset", null)).toThrow(RangeError);
  });
  it("formats periods and days", () => {
    expect(formatInterval("month", 1)).toBe("Monthly");
    expect(formatInterval("year", 1)).toBe("Yearly");
    expect(formatInterval("day", 1)).toBe("Daily");
    expect(formatInterval("week", 1)).toBe("Weekly");
    expect(formatInterval("month", 3)).toBe("Every 3 months");
    expect(formatDay("2026-11-15T23:59:00.000Z")).toBe("15 Nov 2026");
  });
  it("shows exclusive tax as total − Σ lines, and defers to the page when lines are cut at 20", () => {
    const rows = (v: unknown) => {
      const c = renderContent("invoice.issued", v);
      const facts = c.blocks.filter((b) => b.kind === "facts");
      return facts[facts.length - 1]?.kind === "facts" ? facts[facts.length - 1]?.rows : [];
    };
    expect(rows(issued)).toContainEqual(["Tax", "9.90 USD"]);
    expect(rows({ ...issued, total: 9900, amount_due: 9900, amount_remaining: 9900 })?.map((r) => r[0])).not.toContain(
      "Tax",
    );
    const twenty = Array.from({ length: 20 }, (_, i) => ({ description: `Item ${i}`, quantity: 1, amount: 100 }));
    expect(rows({ ...issued, lines: twenty })).toContainEqual(["More lines and tax", "On the invoice page"]);
  });
  it("reminder copy follows the offset (before, on, after the due date)", () => {
    const [before, today, overdue] = SAMPLES["invoice.reminder"].map((v) => renderContent("invoice.reminder", v));
    expect(before?.subject).toMatch(/due in 3 days/);
    expect(today?.subject).toMatch(/due today \[test\]$/);
    expect(overdue?.subject).toMatch(/^Overdue/);
    expect(JSON.stringify(overdue?.blocks)).toContain("last reminder");
    const oneDay = renderContent("invoice.reminder", {
      ...SAMPLES["invoice.reminder"][0],
      reminder: { number: 1, offset_days: -1, last: false },
    });
    expect(oneDay.subject).toMatch(/due in 1 day$/);
  });
  it("escapes merchant-controlled text in the HTML", async () => {
    const r = await createRenderer()(
      "invoice.issued",
      { ...issued, merchant_name: "Acme <script>", lines: [{ description: "<b>x</b>", quantity: 1, amount: 10890 }] },
      "en",
    );
    expect(r.html).not.toContain("<script>");
    expect(r.html).toContain("Acme &lt;script&gt;");
    expect(r.html).toContain("&lt;b&gt;x&lt;/b&gt;");
  });
  it("never claims a verified merchant; refunds on void come from the merchant's wallet", () => {
    for (const t of [
      "invoice.issued",
      "invoice.reminder",
      "invoice.paid",
      "invoice.voided",
      "subscription.renewal_upcoming",
    ] as const)
      for (const v of SAMPLES[t]) expect(JSON.stringify(renderContent(t, v)).toLowerCase()).not.toMatch(/verif/);
    expect(JSON.stringify(renderContent("invoice.voided", SAMPLES["invoice.voided"][0]))).toContain("their own wallet");
  });
  it("hosted invoice links are wiped once sent, and a refused link is never echoed", () => {
    for (const t of ["invoice.issued", "invoice.reminder", "invoice.paid"])
      expect(CREDENTIAL_TEMPLATES.has(t)).toBe(true);
    try {
      safeHref("ftp://pay.example/i/in_1#isec_SECRET");
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(LinkError);
      expect((e as Error).message).not.toContain("SECRET");
      expect((e as Error).message).toContain("ftp:");
    }
    expect(() => safeHref("not a url #isec_SECRET")).toThrow(/^refusing to render a link: /);
  });
});

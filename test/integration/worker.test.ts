/**
 * The `worker` end to end: NATS events → fan-out through spec-mocked identity/payments → SMTP into
 * a real Mailpit; magic links from the api; dedupe, roles, receipts, ops contacts, outages.
 */
import { sql } from "@nearpay-internal/db";
import { newId, toUuid } from "@nearpay-internal/ids";
import { getNotificationRecipients, getReceiptContext, getRefundReceiptContext } from "@nearpay-internal/spec";
import {
  account,
  domainEvent,
  internalSettlementDestination,
  mockError,
  paymentIntent,
} from "@nearpay-internal/testing";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { refund } from "../support/refund.js";
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

  it("KYB decisions reach owners; only the requested info is shown, never a decision reason", async () => {
    const acct = newId("acct");
    const ev = (status: "approved" | "rejected" | "needs_info", reason: string, requested_info?: string) =>
      domainEvent(
        `evt.compliance.kyb.${status}`,
        { account_id: acct, status, reason, ...(requested_info ? { requested_info } : {}) },
        { accountUuid: toUuid(acct, "acct"), livemode: null },
      );
    await s.publishEvent(ev("rejected", "INTERNAL: adverse media"));
    await s.publishEvent(ev("needs_info", "INTERNAL: thin file", "Add your registration number"));
    const ms = await s.mailpit.waitFor(to(`owner+${acct}@merchant.test`), 2);
    const bodies = await Promise.all(ms.map((m) => s.mailpit.message(m.ID)));
    expect(bodies.map((b) => b.Subject).sort()).toEqual([
      "Live payments are not available for your business",
      "We need more information about your business",
    ]);
    expect(bodies.some((b) => b.Text.includes("Add your registration number"))).toBe(true);
    for (const b of bodies) {
      expect(b.Text).not.toContain("INTERNAL");
      expect(b.Text).not.toMatch(/verif/i);
    }
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

describe("stage 2: refund receipts", () => {
  const ctx = (r: ReturnType<typeof refund>, over: Record<string, unknown> = {}) => ({
    customer_email: `refund+${r.id}@example.test`,
    merchant_display_name: "Acme <Shop>",
    livemode: r.livemode,
    refund: r.id,
    payment_intent: r.payment_intent,
    original_amount: 2500,
    original_currency: "usd",
    refunded: { amount: "25000000", asset_id: r.asset_id, decimals: 6, display: "25.00 USDC (Base)" },
    received: { amount: "24910000", asset_id: r.recipient.asset_id, decimals: 6, display: "24.91 USDC (NEAR)" },
    recipient_display: "buyer.near (NEAR Intents)",
    evidence_links: ["https://nearblocks.io/txns/8Ld3Ap4zR2yK7uR3nVbXq1sH4cW9tE6mP2fJ5gD1aB7c"],
    email_receipts: true,
    ...over,
  });

  it("sends the refund receipt to the customer, once, with what came back and the proof", async () => {
    const r = refund({ livemode: true });
    s.payments.on(getRefundReceiptContext, async () => ctx(r));
    const e = domainEvent("evt.payments.refund.succeeded", r, { livemode: true });
    await s.publishEvent(e);
    const { publish } = await import("@nearpay-internal/bus");
    await publish(s.bus as never, e.subject, e, `${e.id}-again`); // redelivery: the inbox dedupes it
    const [m] = await s.mailpit.waitFor(to(`refund+${r.id}@example.test`));
    expect(m?.Subject).toBe("Refund from Acme <Shop>");
    const body = await s.mailpit.message(m?.ID as string);
    expect(body.Text).toContain("Amount returned: 24.91 USDC (NEAR)");
    expect(body.Text).toContain("Sent by the merchant: 25.00 USDC (Base)");
    expect(body.Text).toContain("Original payment: 25.00 USD");
    expect(body.Text).toContain("sent this refund from their own wallet");
    expect(body.HTML).toContain("Acme &lt;Shop&gt;");
    expect(body.HTML).toContain('href="https://nearblocks.io/txns/8Ld3Ap4zR2yK7uR3nVbXq1sH4cW9tE6mP2fJ5gD1aB7c"');
    expect(s.payments.callsTo(getRefundReceiptContext)[0]).toMatchObject({
      params: { id: r.id },
      principal: { ptype: "service", sub: "notify" },
    });
    await new Promise((res) => setTimeout(res, 500));
    expect((await s.mailpit.messages()).filter(to(`refund+${r.id}@example.test`))).toHaveLength(1);
    const row = await s.admin.db
      .selectFrom("messages")
      .select(["dedupe_key", "source"])
      .where("dedupe_key", "=", `refund.receipt:${e.id}:customer`)
      .executeTakeFirstOrThrow();
    expect(row.source).toBe("event:evt.payments.refund.succeeded");
  });

  it("skips receipts turned off, missing emails and a mode payments does not confirm", async () => {
    const off = refund();
    const noEmail = refund();
    const otherMode = refund();
    s.payments.on(getRefundReceiptContext, async (c) => {
      if (c.params.id === off.id) return ctx(off, { email_receipts: false, customer_email: "never1@example.test" });
      if (c.params.id === noEmail.id) return ctx(noEmail, { customer_email: null });
      return ctx(otherMode, { livemode: false, customer_email: "never2@example.test" });
    });
    const events = [off, noEmail, otherMode].map((r) =>
      domainEvent("evt.payments.refund.succeeded", r, { livemode: true }),
    );
    for (const e of events) await s.publishEvent(e);
    await eventually(async () => {
      const r = await sql<{ n: string }>`select count(*)::text as n from jobs where kind = 'event.notify'
        and done_at is not null and dedupe_key in (${sql.join(events.map((e) => `event.notify:${e.id}`))})`.execute(
        s.admin.db,
      );
      return Number(r.rows[0]?.n) === 3;
    });
    const sent = (await s.mailpit.messages()).filter(
      (m) => to("never1@example.test")(m) || to("never2@example.test")(m),
    );
    expect(sent).toEqual([]);
  });

  it("test-mode refund receipts say so (enabled in this stack)", async () => {
    const r = refund({ livemode: false });
    s.payments.on(getRefundReceiptContext, async () => ctx(r, { received: null }));
    await s.publishEvent(domainEvent("evt.payments.refund.succeeded", r, { livemode: false }));
    const [m] = await s.mailpit.waitFor(to(`refund+${r.id}@example.test`));
    expect(m?.Subject).toBe("Refund from Acme <Shop> [test]");
    const body = await s.mailpit.message(m?.ID as string);
    expect(body.Text).toContain("Test mode — no real funds moved.");
    expect(body.Text).toContain("Amount returned: 25.00 USDC (Base)");
  });
});

describe("stage 2: team, approvals and KYB submission", () => {
  const acct = newId("acct");
  const owner = { user_id: newId("usr"), email: `owner2+${acct}@merchant.test`, role: "owner" as const };
  const admin = { user_id: newId("usr"), email: `admin2+${acct}@merchant.test`, role: "admin" as const };
  const admin2 = { user_id: newId("usr"), email: `admin3+${acct}@merchant.test`, role: "admin" as const };
  beforeEach(() => {
    s.identity.on(getNotificationRecipients, async () => ({ recipients: [owner, admin, admin2] }));
  });

  it("owner/admin changes reach owners and admins (audit fix d); others owners only; members named via ?user=", async () => {
    const e = domainEvent(
      "evt.identity.member.role_changed",
      {
        account_id: acct,
        user_id: admin.user_id,
        role: "admin",
        previous_role: "developer",
        actor_user_id: owner.user_id,
      },
      { accountUuid: toUuid(acct, "acct"), livemode: null },
    );
    await s.publishEvent(e);
    const subject = "Security alert: a team member's role changed";
    const ms = await s.mailpit.waitFor(
      (x) => x.Subject === subject && [owner, admin, admin2].some((r) => to(r.email)(x)),
      3,
    );
    const body = await s.mailpit.message(ms[0]?.ID as string);
    expect(body.Text).toContain(`${admin.email} now has the Admin role (was Developer).`);
    expect(body.Text).toContain(`Changed by: ${owner.email}`);

    // a viewer (not on the security list) is named through `?user=` (spec 0.2.1); owners only
    const viewer = { user_id: newId("usr"), email: `viewer+${acct}@merchant.test`, role: "viewer" as const };
    s.identity.on(getNotificationRecipients, async (ctx) => ({
      recipients: ctx.query.user ? (ctx.query.user === viewer.user_id ? [viewer] : []) : [owner, admin, admin2],
    }));
    await s.publishEvent(
      domainEvent(
        "evt.identity.member.added",
        { account_id: acct, user_id: viewer.user_id, role: "viewer", previous_role: null, actor_user_id: null },
        { accountUuid: toUuid(acct, "acct"), livemode: null },
      ),
    );
    const [added] = await s.mailpit.waitFor((x) => to(owner.email)(x) && x.Subject.endsWith("was added"));
    expect((await s.mailpit.message(added?.ID as string)).Text).toContain(`${viewer.email} now has access`);
    expect(s.identity.callsTo(getNotificationRecipients).some((c) => (c.query as { user?: string }).user)).toBe(true);
    await new Promise((res) => setTimeout(res, 500));
    expect(
      (await s.mailpit.messages()).filter(
        (x) => x.Subject.endsWith("was added") && (to(admin.email)(x) || to(admin2.email)(x) || to(viewer.email)(x)),
      ),
    ).toEqual([]);
  });

  it("a destination awaiting approval asks only the owners/admins who have not approved, with the fingerprint", async () => {
    const d = internalSettlementDestination({
      account: acct,
      livemode: true,
      status: "pending_approval",
      approval: { required: 2, approved_by: [admin.user_id], rejected_by: null },
    });
    await s.publishEvent(domainEvent("evt.identity.settlement_destination.pending_approval", d, { livemode: true }));
    const ms = await s.mailpit.waitFor(
      (x) =>
        x.Subject === "Action needed: approve a new settlement destination" &&
        (to(owner.email)(x) || to(admin2.email)(x)),
      2,
    );
    for (const m of ms) expect((await s.mailpit.message(m.ID)).Text).toContain(d.fingerprint);
    await new Promise((res) => setTimeout(res, 500));
    expect(
      (await s.mailpit.messages()).filter(
        (x) => to(admin.email)(x) && x.Subject === "Action needed: approve a new settlement destination",
      ),
    ).toEqual([]);
  });

  it("open onboarding (ADR-0024): no submission mail, the automatic approval is the You're live welcome", async () => {
    await s.publishEvent(
      domainEvent(
        "evt.compliance.kyb.submitted",
        { account_id: acct, status: "pending", submitted_at: "2026-11-07T09:30:00.000Z" },
        { accountUuid: toUuid(acct, "acct"), livemode: null },
      ),
    );
    await s.publishEvent(
      domainEvent(
        "evt.compliance.kyb.approved",
        { account_id: acct, status: "approved", reason: "auto-approved: open onboarding (ADR-0024)" },
        { accountUuid: toUuid(acct, "acct"), livemode: null },
      ),
    );
    const [m] = await s.mailpit.waitFor((x) => to(owner.email)(x) && x.Subject === "You're live on NearPay");
    const text = (await s.mailpit.message(m?.ID as string)).Text;
    expect(text).toContain("you can accept real payments");
    expect(text).not.toContain("auto-approved");
    const all = await s.mailpit.waitFor(to(owner.email), 1);
    expect(all.map((x) => x.Subject)).not.toContain("We received your business details");
  });
});

describe("spec 0.2.1: recovery and secret-rotation mails", () => {
  it("security.recovery reaches the owners and admins of every locked account once each", async () => {
    const a1 = newId("acct");
    const a2 = newId("acct");
    const user = { user_id: newId("usr"), email: `recovered+${a1}@merchant.test`, role: "owner" as const };
    const other = { user_id: newId("usr"), email: `admin+${a2}@merchant.test`, role: "admin" as const };
    const dev = { user_id: newId("usr"), email: `dev+${a2}@merchant.test`, role: "developer" as const };
    s.identity.on(getNotificationRecipients, async (ctx) => ({
      recipients: ctx.params.id === a1 ? [user] : [{ ...user, role: "admin" as const }, other, dev],
    }));
    await s.publishEvent(
      domainEvent(
        "evt.identity.user.recovered",
        {
          user_id: user.user_id,
          account_ids: [a1, a2],
          recovered_at: "2026-11-08T09:00:00.000Z",
          lock_until: "2026-11-10T09:00:00.000Z",
        },
        { accountUuid: null, livemode: null },
      ),
    );
    const subject = "Security alert: account access was recovered";
    const ms = await s.mailpit.waitFor((x) => x.Subject === subject && (to(user.email)(x) || to(other.email)(x)), 2);
    const text = (await s.mailpit.message(ms[0]?.ID as string)).Text;
    expect(text).toContain(`${user.email} regained access`);
    expect(text).toContain("until 2026-11-10 09:00 UTC");
    await new Promise((res) => setTimeout(res, 500));
    const all = (await s.mailpit.messages()).filter((x) => x.Subject === subject);
    expect(all.filter(to(user.email))).toHaveLength(1); // listed on both accounts, mailed once
    expect(all.filter(to(dev.email))).toEqual([]);
  });

  it("webhooks.secret_rotated reaches owners, admins and developers, naming who rotated it", async () => {
    const acct = newId("acct");
    const dev = { user_id: newId("usr"), email: `dev+${acct}@merchant.test`, role: "developer" as const };
    s.identity.on(getNotificationRecipients, async (ctx) => ({
      recipients: ctx.query.kind === "developer" ? [...team(acct), dev] : team(acct),
    }));
    await s.publishEvent(
      domainEvent(
        "evt.webhooks.endpoint.secret_rotated",
        {
          endpoint_id: newId("we"),
          account_id: acct,
          url: "https://merchant.example/webhooks/nearpay",
          previous_secret_expires_at: "2026-11-09T09:00:00.000Z",
          actor_user_id: dev.user_id,
        },
        { accountUuid: toUuid(acct, "acct"), livemode: true },
      ),
    );
    const ms = await s.mailpit.waitFor((x) => x.Subject === "Webhook signing secret rotated", 3);
    expect(ms.filter(to(dev.email))).toHaveLength(1);
    const text = (await s.mailpit.message(ms[0]?.ID as string)).Text;
    expect(text).toContain(`Rotated by: ${dev.email}`);
    expect(text).toContain("Until 2026-11-09 09:00 UTC");
    expect(text).not.toMatch(/whsec_/);
    expect(s.identity.callsTo(getNotificationRecipients).map((c) => (c.query as { kind: string }).kind)).toContain(
      "developer",
    );
  });
});

describe("stage 2: invitation and enrolment links (api → worker → SMTP)", () => {
  it("delivers the invitation naming the account, then wipes the single-use link", async () => {
    const r = await s.call("POST", "/internal/messages", {
      body: {
        template: "team.invitation",
        to: "invitee@merchant.test",
        variables: {
          link_url: "https://dashboard.nearpay.localhost/auth/invite#token=inv-secret",
          account_display_name: "Shop & Co",
          role: "developer",
          expires_in_minutes: 10_080,
        },
        dedupe_key: newId("inv"),
      },
    });
    expect(r.status).toBe(202);
    const id = toUuid((r.body as { message_id: string }).message_id, "msg");
    const [m] = await s.mailpit.waitFor(to("invitee@merchant.test"));
    expect(m?.Subject).toBe("You're invited to join Shop & Co on NearPay");
    const body = await s.mailpit.message(m?.ID as string);
    expect(body.Text).toContain("https://dashboard.nearpay.localhost/auth/invite#token=inv-secret");
    expect(body.Text).toContain("within 7 days");
    const row = await eventually(async () => {
      const x = await s.admin.db.selectFrom("messages").selectAll().where("id", "=", id).executeTakeFirstOrThrow();
      return x.status === "sent" ? x : null;
    });
    expect(s.notify.cipher.decrypt(row.variables_enc, `msg:${row.id}:variables`).toString()).toBe("{}");
  });

  it("delivers the operator enrolment link, then wipes it", async () => {
    const r = await s.call("POST", "/internal/messages", {
      body: {
        template: "ops.enrolment",
        to: "new.operator@nearpay.test",
        variables: {
          link_url: "https://ops.nearpay.localhost/auth/enrol#token=enrol-secret",
          role: "ops_admin",
          expires_in_minutes: 1440,
        },
        dedupe_key: "operator-add:new.operator@nearpay.test:1",
      },
    });
    const id = toUuid((r.body as { message_id: string }).message_id, "msg");
    const [m] = await s.mailpit.waitFor(to("new.operator@nearpay.test"));
    expect(m?.Subject).toBe("[NearPay ops] Set up your console access");
    expect((await s.mailpit.message(m?.ID as string)).Text).toContain("as Ops admin");
    const row = await eventually(async () => {
      const x = await s.admin.db.selectFrom("messages").selectAll().where("id", "=", id).executeTakeFirstOrThrow();
      return x.status === "sent" ? x : null;
    });
    expect(s.notify.cipher.decrypt(row.variables_enc, `msg:${row.id}:variables`).toString()).toBe("{}");
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

  it("two-person approval requests alert every security contact; decided ones send nothing", async () => {
    const now = Math.floor(Date.now() / 1000);
    const approval = (status: string, action: string, target: { type: string; id: string }) => ({
      id: newId("opa"),
      object: "ops_approval",
      action,
      target,
      reason: `needs review ${Math.random()}`,
      status,
      requested_by: { id: newId("usr"), role: "ops" },
      requested_at: now,
      decided_by: null,
      decided_at: null,
      decision_note: null,
      expires_at: now + 3600,
    });
    const acct = newId("acct");
    const suspend = approval("pending", "account.suspend", { type: "account", id: acct });
    const release = approval("pending", "kill_switch.release", { type: "kill_switch", id: "ks_global" });
    const decided = approval("approved", "account.reinstate", { type: "account", id: acct });
    const opts = { accountUuid: null, livemode: null };
    await s.publishEvent(domainEvent("evt.compliance.account.action_requested", suspend, opts));
    await s.publishEvent(domainEvent("evt.sentinel.kill_switch.release_requested", release, opts));
    const decidedEvent = domainEvent("evt.compliance.account.action_requested", decided, opts);
    await s.publishEvent(decidedEvent);
    const ms = await s.mailpit.waitFor(
      (m) =>
        m.Subject === `[NearPay ops] Approval needed: Suspend account ${acct}` ||
        m.Subject === "[NearPay ops] Approval needed: Release the kill switch",
      4,
    );
    expect(new Set(ms.flatMap((m) => m.To.map((t) => t.Address)))).toEqual(
      new Set(["ops@nearpay.test", "oncall@nearpay.test"]),
    );
    const body = await s.mailpit.message(ms[0]?.ID as string);
    expect(body.HTML).toContain('href="https://ops.nearpay.localhost/"');
    await eventually(
      async () =>
        (await s.admin.db.selectFrom("inbox").select("event_id").where("event_id", "=", decidedEvent.id).execute())
          .length === 1,
    );
    const jobs = await sql`select id from jobs where dedupe_key = ${`event.notify:${decidedEvent.id}`}`.execute(
      s.admin.db,
    );
    expect(jobs.rows).toEqual([]);
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

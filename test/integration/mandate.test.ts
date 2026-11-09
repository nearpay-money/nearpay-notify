/**
 * Mandate mails end to end (Stage 4): `evt.billing.mandate.*` on NATS → `event.notify` → spec-mocked
 * billing mandate `notification-context` → SMTP into a real Mailpit. Recipient resolution, the
 * fail-closed checks, idempotent sends, the wiped hosted link and logs without the invoice secret.
 */
import { publish } from "@nearpay-internal/bus";
import { sql } from "@nearpay-internal/db";
import { toUuid } from "@nearpay-internal/ids";
import { getMandateNotificationContext } from "@nearpay-internal/spec";
import { domainEvent, mockError } from "@nearpay-internal/testing";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Notify } from "../../src/app/context.js";
import { type MandateCtx, mandate, mandateContext, vaultTx } from "../support/billing.js";
import { eventually, type Stack, startStack } from "../support/stack.js";

let s: Stack;
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
  // no line notify logged during the suite carries an invoice secret or a payer's email
  expect(logged.length).toBeGreaterThan(0);
  expect(logged.filter((l) => l.includes("isec_") || l.includes("@mandate.test"))).toEqual([]);
});
beforeEach(() => s.billing.reset());

const to = (addr: string) => (m: { To: { Address: string }[] }) => m.To.some((t) => t.Address === addr);
let n = 0;
const payer = () => `payer${++n}@mandate.test`;

async function jobDone(eventId: string) {
  return eventually(async () => {
    const j = await sql<{ done_at: Date | null }>`
      select done_at from jobs where dedupe_key = ${`event.notify:${eventId}`}`.execute(s.admin.db);
    return j.rows[0]?.done_at ? true : null;
  }, 20_000);
}
const messagesOf = (eventId: string) =>
  s.admin.db.selectFrom("messages").selectAll().where("dedupe_key", "like", `%:${eventId}:%`).execute();

/** Serves contexts by mandate id (unknown → 404). */
function serve(...ctxs: MandateCtx[]) {
  const byId = new Map(ctxs.map((c) => [c.mandate, c]));
  s.billing.on(getMandateNotificationContext, async (c) => {
    const ctx = byId.get(c.params.id);
    if (!ctx) mockError("resource_missing", { params: { object: "mandate", id: c.params.id } });
    return ctx as MandateCtx;
  });
}

/** A mandate event and the context billing answers for it (same ids, account and mode). */
function pair(subject: string, ctxOver: Record<string, unknown>, livemode = true) {
  const m = mandate({ livemode });
  const ctx = mandateContext({ mandate: m.id, subscription: m.subscription, livemode, ...ctxOver });
  const e = domainEvent(subject as "evt.billing.mandate.activated", m, {
    livemode,
    accountUuid: toUuid(ctx.account_id, "acct"),
  });
  return { m, ctx, e };
}

describe("mandate.activated", () => {
  it("confirms auto-debit with the cancel call, once, and wipes the hosted link at rest", async () => {
    const email = payer();
    const { m, ctx, e } = pair("evt.billing.mandate.activated", { customer_email: email });
    serve(ctx);
    await s.publishEvent(e);
    if (s.bus) await publish(s.bus, e.subject, e, `${e.id}-redelivered`);

    const [msg] = await s.mailpit.waitFor(to(email));
    expect(msg?.Subject).toBe("Auto-debit is set up for your Acme Test Shop subscription");
    const body = await s.mailpit.message(msg?.ID as string);
    expect(body.Text).toContain("Amount: 25.00 USDC per month");
    expect(body.Text).toContain("Balance: 50.00 USDC (covers 2 periods)");
    expect(body.Text).toContain("Contract: v1.vault.nearpay.near");
    expect(body.Text).toContain("Method: cancel");
    expect(body.Text).toContain('{"mandate_id":7}');
    expect(body.Text).toContain(`Manage auto-debit: ${ctx.manage_url}`);
    expect(body.Text).toContain("NearPay never holds these funds");
    expect(body.HTML).toContain(`href="${ctx.manage_url}"`);
    expect(s.billing.callsTo(getMandateNotificationContext)[0]?.params).toEqual({ id: m.id });

    const row = await eventually(async () => {
      const [r] = await messagesOf(e.id);
      return r?.status === "sent" ? r : null;
    });
    expect(row).toMatchObject({
      template: "mandate.activated",
      dedupe_key: `mandate.activated:${e.id}:customer`,
      source: "event:evt.billing.mandate.activated",
      account_id: toUuid(ctx.account_id, "acct"),
      livemode: true,
    });
    expect(s.notify.cipher.decrypt(row.variables_enc, `msg:${row.id}:variables`).toString()).toBe("{}");
    await new Promise((r) => setTimeout(r, 500));
    expect((await s.mailpit.messages()).filter(to(email))).toHaveLength(1);
    expect(await messagesOf(e.id)).toHaveLength(1);
  });

  it("fails closed: canceled meanwhile, other mode, other account, no email, foreign cancel call, unknown mandate", async () => {
    const cases = [
      pair("evt.billing.mandate.activated", { status: "canceled", cancel_transaction: null }),
      pair("evt.billing.mandate.activated", { livemode: false }),
      pair("evt.billing.mandate.activated", { customer_email: null }),
      pair("evt.billing.mandate.activated", { cancel_transaction: vaultTx("cancel", 7, "evil.near") }),
    ];
    const otherAccount = pair("evt.billing.mandate.activated", {});
    const foreignEnvelope = domainEvent("evt.billing.mandate.activated", otherAccount.m, { livemode: true });
    const unknown = domainEvent("evt.billing.mandate.activated", mandate(), { livemode: true });
    serve(...cases.map((c) => c.ctx), otherAccount.ctx);
    for (const e of [...cases.map((c) => c.e), foreignEnvelope, unknown]) {
      await s.publishEvent(e);
      await jobDone(e.id);
      expect(await messagesOf(e.id)).toEqual([]);
    }
  });

  it("a payload in another mode than its envelope is skipped in the consumer (nested-livemode guard)", async () => {
    const m = mandate({ livemode: false });
    const e = domainEvent("evt.billing.mandate.activated", m, { livemode: true });
    await s.publishEvent(e);
    await new Promise((r) => setTimeout(r, 1_000));
    const j = await sql`select 1 from jobs where dedupe_key = ${`event.notify:${e.id}`}`.execute(s.admin.db);
    expect(j.rows).toEqual([]);
    expect(s.billing.callsTo(getMandateNotificationContext)).toEqual([]);
  });

  it("a billing outage only delays the mail", async () => {
    const email = payer();
    const { ctx, e } = pair("evt.billing.mandate.activated", { customer_email: email });
    let calls = 0;
    s.billing.on(getMandateNotificationContext, async () => {
      calls++;
      if (calls <= 3) mockError("api_error");
      return ctx;
    });
    await s.publishEvent(e);
    await s.mailpit.waitFor(to(email), 1, 40_000);
    expect(calls).toBe(4);
  }, 60_000);
});

describe("the other payer mails", () => {
  it("insufficient_funds asks to top up or pay the emailed invoice", async () => {
    const email = payer();
    const { ctx, e } = pair("evt.billing.mandate.insufficient_funds", {
      customer_email: email,
      status: "insufficient",
      balance: "12000000",
      invoice: "in_01m6pm3ppnengb0aaefsa11e3m",
    });
    serve(ctx);
    await s.publishEvent(e);
    const [msg] = await s.mailpit.waitFor(to(email));
    expect(msg?.Subject).toBe("Top-up needed: auto-debit for Acme Test Shop");
    const text = (await s.mailpit.message(msg?.ID as string)).Text;
    expect(text).toContain("holds only 12.00 USDC");
    expect(text).toContain("in_01m6pm3ppnengb0aaefsa11e3m");
  });

  it("insufficient_funds after a top-up sends nothing", async () => {
    const { ctx, e } = pair("evt.billing.mandate.insufficient_funds", { status: "active" });
    serve(ctx);
    await s.publishEvent(e);
    await jobDone(e.id);
    expect(await messagesOf(e.id)).toEqual([]);
  });

  it("canceled is the refund receipt", async () => {
    const email = payer();
    const { ctx, e } = pair("evt.billing.mandate.canceled", {
      customer_email: email,
      status: "canceled",
      refunded: "50000000",
      balance: "0",
      cancel_transaction: null,
      next_collect_at: null,
    });
    serve(ctx);
    await s.publishEvent(e);
    const [msg] = await s.mailpit.waitFor(to(email));
    expect(msg?.Subject).toBe("Auto-debit canceled: Acme Test Shop");
    const text = (await s.mailpit.message(msg?.ID as string)).Text;
    expect(text).toContain("Returned to you: 50.00 USDC");
    expect(text).toContain("The vault returned 50.00 USDC to dana.near.");
  });

  it("unlinked asks the payer to cancel and names the reason", async () => {
    const email = payer();
    const { ctx, e } = pair("evt.billing.mandate.unlinked", {
      customer_email: email,
      link_status: "unlinked",
      unlinked_reason: "token_mismatch",
    });
    serve(ctx);
    await s.publishEvent(e);
    const [msg] = await s.mailpit.waitFor(to(email));
    expect(msg?.Subject).toBe("Action needed: cancel your mandate for Acme Test Shop to get your funds back");
    const text = (await s.mailpit.message(msg?.ID as string)).Text;
    expect(text).toContain("its token differs from the subscription's");
    expect(text).toContain("Method: cancel");
  });

  it("released (test mode) asks to cancel to get the balance back, with the test banner", async () => {
    const email = payer();
    const { ctx, e } = pair(
      "evt.billing.mandate.released",
      {
        customer_email: email,
        vault_contract: "vault.sandbox.nearpay.near",
        cancel_transaction: vaultTx("cancel", 7, "vault.sandbox.nearpay.near"),
      },
      false,
    );
    serve(ctx);
    await s.publishEvent(e);
    const [msg] = await s.mailpit.waitFor(to(email));
    expect(msg?.Subject).toBe(
      "Auto-debit ended for Acme Test Shop: cancel your mandate to get your balance back [test]",
    );
    const text = (await s.mailpit.message(msg?.ID as string)).Text;
    expect(text).toContain("sandbox vault stand-in");
    expect(text).toContain("50.00 USDC remains in the vault");
    expect(text).toContain("Contract: vault.sandbox.nearpay.near");
  });

  it("collected, exhausted and updated are not mailed (webhooks only)", async () => {
    for (const subject of [
      "evt.billing.mandate.collected",
      "evt.billing.mandate.exhausted",
      "evt.billing.mandate.updated",
    ]) {
      const e = domainEvent(subject as "evt.billing.mandate.collected", mandate(), { livemode: true });
      // the catalogue routes them to webhooks only: notify is not subscribed
      if (s.bus) await publish(s.bus, e.subject, e, e.id);
      await new Promise((r) => setTimeout(r, 300));
      const j = await sql`select 1 from jobs where dedupe_key = ${`event.notify:${e.id}`}`.execute(s.admin.db);
      expect(j.rows).toEqual([]);
    }
  });
});

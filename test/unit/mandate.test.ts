/** Mandate mails to the payer (Stage 4, lld/notify.md §4): routing, fail-closed checks, copy rules. */
import { domainEvent } from "@nearpay-internal/testing";
import { describe, expect, it } from "vitest";
import { CREDENTIAL_TEMPLATES } from "../../src/app/send.js";
import { MANDATE_FITS, MANDATE_TEMPLATES, mandateMail, payerCall } from "../../src/domain/message/mandate.js";
import { NOTIFY_SUBJECTS, planFor, type RoutedEvent, type RoutingOptions } from "../../src/domain/message/routing.js";
import {
  formatDeposit,
  formatGas,
  parseVariables,
  renderContent,
  shortAccount,
  type TemplateName,
} from "../../src/domain/template/catalogue.js";
import { SAMPLES } from "../../src/domain/template/samples.js";
import { type MandateCtx, mandate, mandateContext, subscription, VAULT, vaultTx } from "../support/billing.js";

const o: RoutingOptions = {
  dashboardOrigin: "https://dashboard.nearpay.localhost",
  consoleOrigin: "https://ops.nearpay.localhost",
  testModeReceipts: false,
  chainName: (c) => c,
  fingerprint: () => "FP",
};
const ACCOUNT_UUID = "0193b0c0-0000-7000-8000-0000000000aa";
const ev = (subject: string, object: object, livemode: boolean | null = true): RoutedEvent => ({
  id: "0193b0c0-0000-7000-8000-000000000001",
  account_id: ACCOUNT_UUID,
  subject,
  livemode,
  data: { object },
});
const plan = (e: RoutedEvent, opts = o) => {
  const r = planFor(e, opts);
  if ("skip" in r) throw new Error(r.skip);
  return r.plan;
};
const skip = (e: RoutedEvent, opts = o) => {
  const r = planFor(e, opts);
  return "skip" in r ? r.skip : null;
};

const TEMPLATES = Object.values(MANDATE_TEMPLATES);
/** A context that fits each template. */
const fitting = (t: (typeof TEMPLATES)[number], over: Partial<Record<keyof MandateCtx, unknown>> = {}): MandateCtx =>
  mandateContext({
    ...(t === "mandate.insufficient_funds" ? { status: "insufficient", balance: "1000000" } : {}),
    ...(t === "mandate.canceled"
      ? { status: "canceled", refunded: "50000000", balance: "0", cancel_transaction: null, next_collect_at: null }
      : {}),
    ...(t === "mandate.unlinked" ? { link_status: "unlinked", unlinked_reason: "amount_mismatch" } : {}),
    ...over,
  });
const go = (t: (typeof TEMPLATES)[number], ctx: MandateCtx, livemode: boolean | null = ctx.livemode) =>
  mandateMail(t, ctx, { mandateId: ctx.mandate, subscriptionId: ctx.subscription, livemode, variables: {} });

describe("routing", () => {
  it("routes the five payer subjects, and only those (collected/exhausted/updated go to webhooks only)", () => {
    for (const s of Object.keys(MANDATE_TEMPLATES)) expect(NOTIFY_SUBJECTS).toContain(s);
    for (const s of ["evt.billing.mandate.collected", "evt.billing.mandate.exhausted", "evt.billing.mandate.updated"])
      expect(NOTIFY_SUBJECTS).not.toContain(s);
  });

  it("plans the mandate's customer by ids only: no PII, no link, the envelope's account", () => {
    for (const [subject, template] of Object.entries(MANDATE_TEMPLATES)) {
      const m = mandate();
      expect(plan(ev(subject, m))).toEqual({
        template,
        audience: {
          kind: "mandate_customer",
          mandateId: m.id,
          subscriptionId: m.subscription,
          accountUuid: ACCOUNT_UUID,
        },
        variables: {},
        accountId: null,
        livemode: true,
      });
    }
  });

  it("nested-livemode guard: a payload in another mode than the envelope sends nothing", () => {
    expect(skip(ev("evt.billing.mandate.activated", mandate({ livemode: false }), true))).toBe(
      "the mandate's mode differs from the event's",
    );
    expect(skip(ev("evt.billing.mandate.activated", mandate({ livemode: true }), null))).toBe(
      "the mandate's mode differs from the event's",
    );
  });

  it("test-mode mandate mails follow NP_TEST_MODE_RECEIPTS", () => {
    const e = ev("evt.billing.mandate.released", mandate({ livemode: false }), false);
    expect(skip(e)).toBe("test-mode customer mails are off");
    expect(plan(e, { ...o, testModeReceipts: true }).livemode).toBe(false);
  });

  it("platform envelopes keep a null account (the check is skipped, not faked)", () => {
    const m = mandate();
    const e = { ...ev("evt.billing.mandate.activated", m), account_id: undefined };
    expect(plan(e).audience).toMatchObject({ accountUuid: null });
  });

  it("a renewal of an auto-debit subscription says so", () => {
    const e = domainEvent(
      "evt.billing.subscription.renewal_upcoming",
      subscription({ collection_method: "auto_debit" }),
      {
        livemode: true,
      },
    );
    expect(plan(e as unknown as RoutedEvent).variables).toEqual({ auto_debit: true });
    const manual = domainEvent("evt.billing.subscription.renewal_upcoming", subscription(), { livemode: true });
    expect(plan(manual as unknown as RoutedEvent).variables).toEqual({ auto_debit: false });
  });
});

describe("mandateMail — fail closed", () => {
  it("each template goes out to the context's customer with variables the catalogue accepts", () => {
    for (const t of TEMPLATES) {
      const ctx = fitting(t);
      const r = go(t, ctx);
      if ("skip" in r) throw new Error(`${t}: ${r.skip}`);
      expect(r.to).toBe("dana@customer.test");
      expect(r.accountId).toBe(ctx.account_id);
      const v = parseVariables(t as TemplateName, r.variables) as Record<string, unknown>;
      expect(v.manage_url).toBe(ctx.manage_url);
      expect(v.amount_per_period).toBe("25000000");
      expect(v.token).toEqual({ symbol: "USDC", decimals: 6 });
    }
  });

  it("another mandate, subscription or mode, or no email → nothing", () => {
    const ctx = fitting("mandate.activated");
    const base = { subscriptionId: ctx.subscription, livemode: true, variables: {} };
    expect(mandateMail("mandate.activated", ctx, { ...base, mandateId: "md_other" })).toEqual({
      skip: "billing answered for another mandate",
    });
    expect(
      mandateMail("mandate.activated", ctx, { ...base, mandateId: ctx.mandate, subscriptionId: "sub_other" }),
    ).toEqual({ skip: "billing names another subscription" });
    expect(go("mandate.activated", ctx, false)).toEqual({ skip: "billing reports another mode" });
    expect(go("mandate.activated", ctx, null)).toEqual({ skip: "billing reports another mode" });
    expect(go("mandate.activated", fitting("mandate.activated", { customer_email: null }))).toEqual({
      skip: "the customer has no email on record",
    });
  });

  it("the status must still fit the mail", () => {
    for (const t of TEMPLATES)
      for (const status of ["active", "insufficient", "exhausted", "canceled"]) {
        const ctx = fitting(t, { status });
        const r = go(t, ctx);
        expect("skip" in r, `${t} ${status}`).toBe(!MANDATE_FITS[t].statuses.includes(status));
      }
    expect(go("mandate.activated", fitting("mandate.activated", { link_status: "unlinked" }))).toEqual({
      skip: "the mandate is unlinked now (mandate.activated no longer fits)",
    });
    expect(go("mandate.unlinked", fitting("mandate.unlinked", { link_status: "linked" }))).toEqual({
      skip: "the mandate is linked now (mandate.unlinked no longer fits)",
    });
  });

  it("FR-BIL-04: activation, unlinked and released mails need the payer's cancel call", () => {
    for (const t of ["mandate.activated", "mandate.unlinked", "mandate.released"] as const)
      expect(go(t, fitting(t, { cancel_transaction: null }))).toEqual({
        skip: "billing returned no cancel transaction",
      });
    expect(
      "skip" in go("mandate.insufficient_funds", fitting("mandate.insufficient_funds", { cancel_transaction: null })),
    ).toBe(false);
  });

  it("a transaction to another contract, method or signer is never mailed", () => {
    const bad = [
      vaultTx("cancel", 7, "evil.near"),
      vaultTx("withdraw"),
      { ...vaultTx("cancel"), signer_id: "mallory.near" },
      { ...vaultTx("cancel"), actions: [...vaultTx("cancel").actions, ...vaultTx("cancel").actions] },
    ];
    for (const tx of bad)
      expect(go("mandate.activated", fitting("mandate.activated", { cancel_transaction: tx }))).toEqual({
        skip: "the cancel transaction does not call the mandate's vault",
      });
    expect(
      go(
        "mandate.canceled",
        fitting("mandate.canceled", { refunded: "0", withdraw_transaction: vaultTx("withdraw", 7, "evil.near") }),
      ),
    ).toEqual({ skip: "the withdraw transaction does not call the mandate's vault" });
    // the payer as explicit signer is fine
    expect(
      "skip" in
        go(
          "mandate.activated",
          fitting("mandate.activated", { cancel_transaction: { ...vaultTx("cancel"), signer_id: "dana.near" } }),
        ),
    ).toBe(false);
  });

  it("a cancel receipt needs the refunded amount", () => {
    expect(go("mandate.canceled", fitting("mandate.canceled", { refunded: null }))).toEqual({
      skip: "billing reports no refund amount",
    });
  });

  it("payerCall spells the single call out", () => {
    expect(payerCall(vaultTx("cancel"), VAULT, "cancel", "dana.near")).toEqual({
      contract: VAULT,
      method: "cancel",
      args_json: '{"mandate_id":7}',
      deposit_yocto: "1",
      gas: "100000000000000",
    });
    expect(payerCall({ ...vaultTx("cancel"), actions: [] }, VAULT, "cancel", "dana.near")).toBeNull();
  });
});

describe("copy", () => {
  const text = (t: TemplateName, v: unknown) => {
    const c = renderContent(t, v);
    return [c.subject, c.preheader, c.heading, ...c.blocks.map((b) => JSON.stringify(b))].join("\n");
  };

  it("every mandate mail states NearPay never holds the funds (INV-1)", () => {
    for (const t of TEMPLATES)
      for (const v of SAMPLES[t]) expect(text(t, v)).toContain("NearPay never holds these funds");
  });

  it("test-mode mails carry the banner and the [test] tag", () => {
    for (const t of TEMPLATES)
      for (const v of SAMPLES[t]) {
        const c = renderContent(t, v);
        const live = (v as { livemode: boolean }).livemode;
        expect(c.subject.endsWith(" [test]")).toBe(!live);
        expect(JSON.stringify(c.blocks).includes("sandbox vault stand-in")).toBe(!live);
      }
  });

  it("the activation mail always shows how to cancel: vault, mandate id and the cancel call", () => {
    const t = text("mandate.activated", SAMPLES["mandate.activated"][0]);
    expect(t).toContain("v1.vault.nearpay.near");
    expect(t).toContain('"Vault mandate id","7"');
    expect(t).toContain('{\\"mandate_id\\":7}');
    expect(t).toContain('"Method","cancel"');
    expect(t).toContain("You can cancel at any time");
  });

  it("the activation schema refuses a mail without the cancel call", () => {
    expect(() =>
      parseVariables("mandate.activated", { ...SAMPLES["mandate.activated"][0], cancel_call: null }),
    ).toThrow(/cancel_call/);
  });

  it("canceled: refund receipt, failed refund (withdraw), nothing left", () => {
    const [refunded, failed, empty] = SAMPLES["mandate.canceled"];
    expect(text("mandate.canceled", refunded)).toContain("The vault returned 75.00 USDC to dana.near.");
    const f = text("mandate.canceled", failed);
    expect(f).toContain("The refund failed");
    expect(f).toContain('"Method","withdraw"');
    expect(f).not.toContain("Returned to you");
    expect(text("mandate.canceled", empty)).toContain("No balance remained on the mandate.");
    expect(text("mandate.canceled", { ...failed, balance: "0" })).toContain("your remaining balance stays");
  });

  it("unlinked: names the reason in plain words and asks to cancel", () => {
    const [v, unknown] = SAMPLES["mandate.unlinked"];
    expect(text("mandate.unlinked", v)).toContain("its amount per period differs from the subscription's price");
    expect(text("mandate.unlinked", unknown)).toContain("its terms do not match the subscription's");
    expect(text("mandate.unlinked", { ...v, unlinked_reason: "something_new" })).toContain(
      "its terms do not match the subscription's",
    );
    expect(text("mandate.unlinked", v)).toContain("Cancel the mandate to get your balance of 75.00 USDC back");
  });

  it("released: asks to cancel to get the balance back", () => {
    const [left, none] = SAMPLES["mandate.released"];
    expect(text("mandate.released", left)).toContain("75.00 USDC remains in the vault");
    expect(text("mandate.released", none)).toContain("No balance remains on the mandate");
  });

  it("insufficient funds: top up or pay the emailed invoice", () => {
    const t = text("mandate.insufficient_funds", SAMPLES["mandate.insufficient_funds"][0]);
    expect(t).toContain("holds only 12.00 USDC");
    expect(t).toContain("in_01m6pm3ppnengb0aaefsa11e3m");
    expect(t).toContain("Top up or pay");
  });

  it("a period without the subscription's interval reads `per period`", () => {
    const v = { ...SAMPLES["mandate.insufficient_funds"][0], interval: null, interval_count: null };
    expect(text("mandate.insufficient_funds", v)).toContain("25.00 USDC per period");
  });

  it("formats NEAR accounts, gas and deposits", () => {
    expect(shortAccount("dana.near")).toBe("dana.near");
    expect(shortAccount("a".repeat(64))).toBe(`${"a".repeat(8)}…${"a".repeat(8)}`);
    expect(formatGas("100000000000000")).toBe("100 Tgas");
    expect(formatGas("2500000000000")).toBe("2.5 Tgas");
    expect(formatDeposit("1")).toBe("1 yoctoNEAR");
    expect(formatDeposit("10000000000000000000000")).toBe("0.01 NEAR");
  });

  it("the hosted link is wiped once sent (it carries the invoice secret)", () => {
    for (const t of TEMPLATES) expect(CREDENTIAL_TEMPLATES.has(t)).toBe(true);
  });
});

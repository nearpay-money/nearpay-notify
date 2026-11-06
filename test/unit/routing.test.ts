import { newId } from "@nearpay-internal/ids";
import { SUBJECTS, type Subject } from "@nearpay-internal/spec";
import { account, domainEvent, internalSettlementDestination, paymentIntent } from "@nearpay-internal/testing";
import { describe, expect, it } from "vitest";
import { NOTIFY_SUBJECTS, planFor, type RoutingOptions } from "../../src/domain/message/routing.js";

const o: RoutingOptions = {
  dashboardOrigin: "https://dashboard.nearpay.localhost",
  testModeReceipts: false,
  chainName: (c) => (c === "near:mainnet" ? "NEAR" : c),
  fingerprint: (chain, address, asset) => `${chain.length}-${address.length}-${asset.length}`,
};
const plan = (e: Parameters<typeof planFor>[0], opts = o) => {
  const r = planFor(e, opts);
  if (!("plan" in r)) throw new Error(`skipped: ${r.skip}`);
  return r.plan;
};
const skip = (e: Parameters<typeof planFor>[0], opts = o) => {
  const r = planFor(e, opts);
  if ("plan" in r) throw new Error("expected a skip");
  return r.skip;
};

describe("routing coverage", () => {
  it("covers exactly the subjects the catalogue routes to notify", () => {
    const routed = (Object.keys(SUBJECTS) as Subject[]).filter((s) => SUBJECTS[s].consumers.includes("notify")).sort();
    expect([...NOTIFY_SUBJECTS].sort()).toEqual(routed);
  });
  it("skips subjects it does not handle", () => {
    expect(skip({ id: "x", subject: "evt.identity.account.updated", livemode: false, data: { object: {} } })).toMatch(
      /does not handle/,
    );
  });
});

describe("identity events", () => {
  it("welcomes the owner of a new account", () => {
    const a = account({ display_name: "Acme" });
    const p = plan(domainEvent("evt.identity.account.created", a));
    expect(p).toEqual({
      template: "account.welcome",
      audience: { kind: "account", accountId: a.id, recipients: "security", roles: ["owner"] },
      variables: { account_name: "Acme", dashboard_url: o.dashboardOrigin },
      accountId: a.id,
      livemode: false,
    });
  });
  it("alerts owners and admins on destination changes, with the fingerprint", () => {
    const d = internalSettlementDestination({
      status: "cooling_off",
      active_at: 1_793_000_000,
      fingerprint: "7KQ2-M9XA-31",
    });
    const pending = plan(domainEvent("evt.identity.settlement_destination.cooling_off", d));
    expect(pending.template).toBe("security.destination_pending");
    expect(pending.audience).toEqual({ kind: "account", accountId: d.account, recipients: "security" });
    expect(pending.variables).toMatchObject({
      fingerprint: "7KQ2-M9XA-31",
      chain_name: "NEAR",
      address: d.address,
      label: d.label,
      active_at: new Date(1_793_000_000_000).toISOString(),
    });
    const noDate = plan(domainEvent("evt.identity.settlement_destination.cooling_off", { ...d, active_at: null }));
    expect(noDate.variables.active_at).toBeNull();
    expect(plan(domainEvent("evt.identity.settlement_destination.activated", d)).template).toBe(
      "security.destination_activated",
    );
    const disabled = plan(
      domainEvent("evt.identity.settlement_destination.disabled", {
        ...d,
        status: "disabled",
        disabled_reason: "compliance",
      }),
    );
    expect(disabled).toMatchObject({
      template: "security.destination_disabled",
      variables: { disabled_reason: "compliance" },
    });
    const noReason = plan(domainEvent("evt.identity.settlement_destination.disabled", { ...d, disabled_reason: null }));
    expect(noReason.variables.disabled_reason).toBeNull();
  });
});

describe("payment receipts", () => {
  it("send for live payments to the customer, with the destination fingerprint", () => {
    const pi = paymentIntent({ livemode: true, status: "succeeded" });
    const p = plan(domainEvent("evt.payments.payment_intent.succeeded", pi, { livemode: true }));
    expect(p).toMatchObject({
      template: "payment.receipt",
      audience: { kind: "customer", paymentIntentId: pi.id },
      livemode: true,
    });
    expect(p.variables).toEqual({
      payment_id: pi.id,
      livemode: true,
      destination_fingerprint: o.fingerprint(pi.destination.chain, pi.destination.address, pi.destination.asset_id),
    });
  });
  it("test-mode receipts only when enabled", () => {
    const pi = paymentIntent({ livemode: false, status: "succeeded" });
    const e = domainEvent("evt.payments.payment_intent.succeeded", pi, { livemode: false });
    expect(skip(e)).toBe("test-mode receipts are off");
    expect(plan(e, { ...o, testModeReceipts: true }).variables).toMatchObject({ livemode: false });
  });
  it("tolerates a payment without a destination snapshot", () => {
    const e = {
      id: "e",
      subject: "evt.payments.payment_intent.succeeded",
      livemode: true,
      data: { object: { id: "pi_1" } },
    };
    expect(plan(e).variables.destination_fingerprint).toBeNull();
  });
});

describe("compliance events", () => {
  const acct = newId("acct");
  const ev = (subject: string, object: unknown, livemode: boolean | null = null) => ({
    id: "e1",
    subject,
    livemode,
    data: { object },
  });
  it("KYB decisions go to owners; only needs_info carries the reason", () => {
    for (const status of ["approved", "rejected", "needs_info"] as const) {
      const p = plan(ev(`evt.compliance.kyb.${status}`, { account_id: acct, status, reason: "internal note" }));
      expect(p.template).toBe("kyb.decision");
      expect(p.audience).toEqual({ kind: "account", accountId: acct, recipients: "security", roles: ["owner"] });
      expect(p.variables.reason).toBe(status === "needs_info" ? "internal note" : null);
    }
    expect(
      plan(ev("evt.compliance.kyb.needs_info", { account_id: acct, status: "needs_info" })).variables.reason,
    ).toBeNull();
  });
  it("blocks, suspensions and reviews", () => {
    const blocked = plan(
      ev("evt.compliance.destination.blocked", { destination_id: "sd_1", account_id: acct, reason: "internal" }),
    );
    expect(blocked).toMatchObject({ template: "security.destination_blocked", variables: { destination_id: "sd_1" } });
    expect(JSON.stringify(blocked.variables)).not.toContain("internal");
    expect(plan(ev("evt.compliance.account.suspended", { account_id: acct, reason: "r" })).template).toBe(
      "account.suspended",
    );
    const back = plan(ev("evt.compliance.account.reinstated", { account_id: acct, reason: "r" }));
    expect(back).toMatchObject({ template: "account.reinstated", audience: { roles: ["owner"] } });
    const review = {
      id: "case_1",
      object: "review",
      account_id: acct,
      subject: { type: "execution", id: "ex_1" },
      reason: "held_execution",
      status: "open",
    };
    expect(plan(ev("evt.compliance.review.opened", review, true))).toMatchObject({
      template: "review.opened",
      variables: { subject_type: "execution", subject_id: "ex_1", livemode: true },
      audience: { recipients: "security" },
    });
    expect(plan(ev("evt.compliance.review.closed", review, false))).toMatchObject({
      template: "review.closed",
      variables: { livemode: false },
    });
  });
});

describe("ops and webhooks events", () => {
  const ev = (subject: string, object: unknown) => ({ id: "e1", subject, livemode: null, data: { object } });
  it("kill switch changes go to the security contacts", () => {
    expect(
      plan(ev("evt.sentinel.kill_switch.engaged", { engaged: true, reason: "r", actor: "sentinel" })),
    ).toMatchObject({
      template: "ops.kill_switch",
      audience: { kind: "security_contacts" },
      variables: { engaged: true },
    });
    expect(
      plan(ev("evt.sentinel.kill_switch.released", { engaged: false, reason: "r", actor: "ops" })).variables.engaged,
    ).toBe(false);
  });
  it("audit findings: live non-passing ones only", () => {
    const f = {
      id: "fnd_1",
      execution_id: "ex_1",
      account_id: "acct_1",
      livemode: true,
      check_kind: "k",
      result: "mismatch",
      details: {},
    };
    expect(plan(ev("evt.sentinel.audit_finding.created", f))).toMatchObject({
      template: "ops.audit_finding",
      accountId: "acct_1",
    });
    expect(skip(ev("evt.sentinel.audit_finding.created", { ...f, result: "pass" }))).toBe("the finding passed");
    expect(skip(ev("evt.sentinel.audit_finding.created", { ...f, livemode: false }))).toBe("test-mode finding");
  });
  it("disabled webhook endpoints go to developers", () => {
    const x = {
      endpoint_id: "we_1",
      account_id: "acct_1",
      url: "https://m.example/h",
      reason: "failing",
      failing_since: "2026-11-01T00:00:00.000Z",
    };
    expect(plan(ev("evt.webhooks.endpoint.disabled", x))).toMatchObject({
      template: "webhooks.endpoint_disabled",
      audience: { kind: "account", accountId: "acct_1", recipients: "developer" },
      variables: { url: "https://m.example/h", failing_since: x.failing_since },
    });
  });
});

import { newId } from "@nearpay-internal/ids";
import { SUBJECTS, type Subject } from "@nearpay-internal/spec";
import { account, domainEvent, internalSettlementDestination, paymentIntent } from "@nearpay-internal/testing";
import { describe, expect, it } from "vitest";
import { NOTIFY_SUBJECTS, planFor, type RoutingOptions } from "../../src/domain/message/routing.js";

const o: RoutingOptions = {
  dashboardOrigin: "https://dashboard.nearpay.localhost",
  consoleOrigin: "https://ops.nearpay.localhost",
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
  it("KYB decisions go to owners; only needs_info carries the requested info, never the reason", () => {
    for (const status of ["approved", "rejected", "needs_info"] as const) {
      const p = plan(
        ev(`evt.compliance.kyb.${status}`, {
          account_id: acct,
          status,
          reason: "internal note",
          requested_info: "Add the registration number",
        }),
      );
      expect(p.template).toBe("kyb.decision");
      expect(p.audience).toEqual({ kind: "account", accountId: acct, recipients: "security", roles: ["owner"] });
      expect(p.variables.requested_info).toBe(status === "needs_info" ? "Add the registration number" : null);
      expect(JSON.stringify(p.variables)).not.toContain("internal note");
    }
    // a Stage 1 producer (no requested_info) never leaks its reason
    expect(
      plan(ev("evt.compliance.kyb.needs_info", { account_id: acct, status: "needs_info", reason: "internal" }))
        .variables.requested_info,
    ).toBeNull();
  });
  it("a KYB submission goes to owners", () => {
    const submitted = "2026-11-07T09:30:00.000Z";
    expect(
      plan(ev("evt.compliance.kyb.submitted", { account_id: acct, status: "pending", submitted_at: submitted })),
    ).toEqual({
      template: "kyb.submitted",
      audience: { kind: "account", accountId: acct, recipients: "security", roles: ["owner"] },
      variables: { submitted_at: submitted, dashboard_url: o.dashboardOrigin },
      accountId: acct,
      livemode: null,
    });
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

describe("stage 2: refund receipts", () => {
  const refund = (livemode: boolean) => ({
    id: newId("re"),
    payment_intent: newId("pi"),
    livemode,
    status: "succeeded",
  });
  it("send to the refunded customer, resolved through payments", () => {
    const r = refund(true);
    const e = { id: "e", subject: "evt.payments.refund.succeeded", livemode: true, data: { object: r } };
    expect(plan(e)).toEqual({
      template: "refund.receipt",
      audience: { kind: "refund_customer", refundId: r.id },
      variables: { refund_id: r.id, payment_id: r.payment_intent, livemode: true },
      accountId: null,
      livemode: true,
    });
  });
  it("test-mode refund receipts only when enabled", () => {
    const e = { id: "e", subject: "evt.payments.refund.succeeded", livemode: false, data: { object: refund(false) } };
    expect(skip(e)).toBe("test-mode receipts are off");
    expect(plan(e, { ...o, testModeReceipts: true }).variables.livemode).toBe(false);
  });
});

describe("stage 2: team and destination approval", () => {
  const acct = newId("acct");
  const member = newId("usr");
  const owner = newId("usr");
  const ev = (subject: string, object: unknown) => ({ id: "e2", subject, livemode: null, data: { object } });
  it("owner/admin changes go to owners and admins (identity audit fix d); others to owners; emails at fan-out", () => {
    const p = plan(
      ev("evt.identity.member.role_changed", {
        account_id: acct,
        user_id: member,
        role: "owner",
        previous_role: "admin",
        actor_user_id: owner,
      }),
    );
    expect(p).toEqual({
      template: "security.member_changed",
      audience: { kind: "account", accountId: acct, recipients: "security", roles: ["owner", "admin"] },
      variables: {
        change: "role_changed",
        member_id: member,
        role: "owner",
        previous_role: "admin",
        actor_id: owner,
        dashboard_url: o.dashboardOrigin,
      },
      accountId: acct,
      livemode: null,
      userEmails: { member_email: member, actor_email: owner },
    });
    for (const change of ["added", "removed"] as const) {
      const x = plan(
        ev(`evt.identity.member.${change}`, {
          account_id: acct,
          user_id: member,
          role: "viewer",
          previous_role: null,
          actor_user_id: null,
        }),
      );
      expect(x.variables).toMatchObject({ change, previous_role: null, actor_id: null });
      expect(x.userEmails).toEqual({ member_email: member, actor_email: null });
      expect(x.audience).toMatchObject({ roles: ["owner"] });
    }
    // demoting an admin to viewer is an owner/admin change too
    const demoted = plan(
      ev("evt.identity.member.role_changed", {
        account_id: acct,
        user_id: member,
        role: "viewer",
        previous_role: "admin",
        actor_user_id: owner,
      }),
    );
    expect(demoted.audience).toMatchObject({ roles: ["owner", "admin"] });
    const removedAdmin = plan(
      ev("evt.identity.member.removed", {
        account_id: acct,
        user_id: member,
        role: "admin",
        previous_role: null,
        actor_user_id: owner,
      }),
    );
    expect(removedAdmin.audience).toMatchObject({ roles: ["owner", "admin"] });
  });
  it("a destination awaiting approval asks the owners/admins who have not approved yet", () => {
    const d = internalSettlementDestination({
      status: "pending_approval",
      fingerprint: "7KQ2-M9XA-31",
      approval: { required: 2, approved_by: [owner], rejected_by: null },
    } as never);
    const p = plan(domainEvent("evt.identity.settlement_destination.pending_approval", d));
    expect(p.template).toBe("security.destination_approval");
    expect(p.audience).toEqual({ kind: "account", accountId: d.account, recipients: "security", exclude: [owner] });
    expect(p.variables).toMatchObject({
      fingerprint: "7KQ2-M9XA-31",
      address: d.address,
      approvals_required: 2,
      approvals_received: 1,
    });
    const legacy = plan(
      domainEvent("evt.identity.settlement_destination.pending_approval", { ...d, approval: undefined } as never),
    );
    expect(legacy.audience).toMatchObject({ exclude: [] });
    // spec 0.2.1 `created_by`: the creator is excluded even when not counted in approved_by
    const creator = newId("usr");
    const withCreator = plan(
      domainEvent("evt.identity.settlement_destination.pending_approval", {
        ...d,
        created_by: creator,
        approval: { required: 2, approved_by: [owner], rejected_by: null },
      } as never),
    );
    expect(withCreator.audience).toMatchObject({ exclude: [creator, owner] });
    const sameCreator = plan(
      domainEvent("evt.identity.settlement_destination.pending_approval", { ...d, created_by: owner } as never),
    );
    expect(sameCreator.audience).toMatchObject({ exclude: [owner] });
    expect(legacy.variables).toMatchObject({ approvals_required: 2, approvals_received: 0 });
    expect(
      skip(
        domainEvent("evt.identity.settlement_destination.pending_approval", {
          ...d,
          approval: { required: 2, approved_by: [owner], rejected_by: member },
        } as never),
      ),
    ).toBe("the destination was rejected");
  });
});

describe("spec 0.2.1: recovery and secret rotation", () => {
  const acct = newId("acct");
  const owner = newId("usr");
  const ev = (subject: string, object: unknown, livemode: boolean | null = null) => ({
    id: "e4",
    subject,
    livemode,
    data: { object },
  });
  it("security.recovery: owners and admins of every locked account; the user named at fan-out", () => {
    const user = newId("usr");
    const a2 = newId("acct");
    const object = {
      user_id: user,
      account_ids: [acct, a2],
      recovered_at: "2026-11-08T09:00:00.000Z",
      lock_until: "2026-11-10T09:00:00.000Z",
    };
    const p = plan(ev("evt.identity.user.recovered", object));
    expect(p).toEqual({
      template: "security.recovery",
      audience: { kind: "accounts", accountIds: [acct, a2], recipients: "security", roles: ["owner", "admin"] },
      variables: {
        user_id: user,
        recovered_at: object.recovered_at,
        lock_until: object.lock_until,
        dashboard_url: o.dashboardOrigin,
      },
      accountId: null,
      livemode: null,
      userEmails: { user_email: user },
    });
    expect(skip(ev("evt.identity.user.recovered", { ...object, account_ids: [] }))).toBe("the user manages no account");
  });
  it("webhooks.secret_rotated: owners, admins and developers; never a secret", () => {
    const we = newId("we");
    const object = {
      endpoint_id: we,
      account_id: acct,
      url: "https://shop.example/hook",
      previous_secret_expires_at: null,
      actor_user_id: owner,
    };
    const p = plan(ev("evt.webhooks.endpoint.secret_rotated", object, true));
    expect(p).toEqual({
      template: "webhooks.secret_rotated",
      audience: { kind: "account", accountId: acct, recipients: "developer" },
      variables: {
        endpoint_id: we,
        url: object.url,
        previous_secret_expires_at: null,
        actor_id: owner,
        livemode: true,
        dashboard_url: o.dashboardOrigin,
      },
      accountId: acct,
      livemode: true,
      userEmails: { actor_email: owner },
    });
    expect(JSON.stringify(p)).not.toMatch(/whsec_/);
  });
});

describe("stage 2: ops approval requests", () => {
  const approval = (over: Record<string, unknown> = {}) => ({
    id: newId("opa"),
    object: "ops_approval",
    action: "account.suspend",
    target: { type: "account", id: "acct_1" },
    reason: "investigating",
    status: "pending",
    requested_by: { id: "usr_ops1", role: "ops" },
    requested_at: 1_793_000_000,
    decided_by: null,
    decided_at: null,
    decision_note: null,
    expires_at: 1_793_086_400,
    ...over,
  });
  const ev = (subject: string, object: unknown) => ({ id: "e3", subject, livemode: null, data: { object } });
  it("pending requests alert the security contacts with a console link", () => {
    const a = approval();
    expect(plan(ev("evt.compliance.account.action_requested", a))).toEqual({
      template: "ops.approval_requested",
      audience: { kind: "security_contacts" },
      variables: {
        approval_id: a.id,
        action: "account.suspend",
        target_type: "account",
        target_id: "acct_1",
        reason: "investigating",
        requested_by: "usr_ops1",
        requested_by_role: "ops",
        requested_at: new Date(1_793_000_000_000).toISOString(),
        expires_at: new Date(1_793_086_400_000).toISOString(),
        console_url: o.consoleOrigin,
      },
      accountId: "acct_1",
      livemode: null,
    });
    const ks = plan(
      ev(
        "evt.sentinel.kill_switch.release_requested",
        approval({ action: "kill_switch.release", target: { type: "kill_switch", id: "ks_global" }, reason: "" }),
      ),
    );
    expect(ks).toMatchObject({ accountId: null, variables: { target_id: "ks_global", reason: "(no reason given)" } });
  });
  it("decided requests send nothing", () => {
    for (const status of ["approved", "rejected", "expired"])
      expect(skip(ev("evt.compliance.account.action_requested", approval({ status })))).toBe(
        `the request is ${status}`,
      );
  });
});

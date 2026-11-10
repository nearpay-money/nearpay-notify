import { describe, expect, it } from "vitest";
import {
  formatDuration,
  formatPrice,
  isTemplate,
  parseVariables,
  renderContent,
  resolveLocale,
  TEMPLATE_NAMES,
  VariablesError,
} from "../../src/domain/template/catalogue.js";
import { SAMPLES } from "../../src/domain/template/samples.js";

describe("locales", () => {
  it("falls back to English", () => {
    expect(resolveLocale("en")).toBe("en");
    expect(resolveLocale("en-GB")).toBe("en");
    expect(resolveLocale("EN_us")).toBe("en");
    expect(resolveLocale("de")).toBe("en");
    expect(resolveLocale(undefined)).toBe("en");
    expect(resolveLocale(null)).toBe("en");
  });
});

describe("variables", () => {
  it("every template has samples that validate", () => {
    for (const t of TEMPLATE_NAMES) {
      expect(SAMPLES[t].length, t).toBeGreaterThan(0);
      for (const v of SAMPLES[t]) expect(() => parseVariables(t, v), t).not.toThrow();
    }
  });
  it("reports every invalid field", () => {
    try {
      parseVariables("auth.magic_link", { link_url: "javascript:alert(1)", purpose: "phish", expires_in_minutes: 0 });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(VariablesError);
      expect((e as VariablesError).issues.map((i) => i.split(":")[0])).toEqual([
        "link_url",
        "purpose",
        "expires_in_minutes",
      ]);
    }
    expect(() => parseVariables("account.welcome", null)).toThrow(/\(root\)/);
  });
  it("knows its templates", () => {
    expect(isTemplate("auth.magic_link")).toBe(true);
    expect(isTemplate("toString")).toBe(false);
    expect(isTemplate("marketing.newsletter")).toBe(false);
  });
});

describe("formatPrice", () => {
  it("uses the currency's minor units", () => {
    expect(formatPrice(2500, "usd", "x")).toBe("25.00 USD");
    expect(formatPrice(5, "eur", "x")).toBe("0.05 EUR");
    expect(formatPrice(1200, "jpy", "x")).toBe("1200 JPY");
  });
  it("asset pricing shows the settled value", () => {
    expect(formatPrice("2000000", "asset", "2.00 USDC (Base)")).toBe("2.00 USDC (Base)");
  });
});

describe("formatDuration", () => {
  it("names the largest whole unit", () => {
    expect(formatDuration(1)).toBe("1 minute");
    expect(formatDuration(15)).toBe("15 minutes");
    expect(formatDuration(60)).toBe("1 hour");
    expect(formatDuration(90)).toBe("90 minutes");
    expect(formatDuration(1440)).toBe("24 hours");
    expect(formatDuration(2880)).toBe("2 days");
    expect(formatDuration(10_080)).toBe("7 days");
  });
});

describe("copy rules", () => {
  const body = (c: ReturnType<typeof renderContent>) => JSON.stringify(c.blocks);
  const all = () =>
    TEMPLATE_NAMES.flatMap((t) =>
      SAMPLES[t].map((v) => {
        const c = renderContent(t, v);
        return { t, text: `${c.subject} ${c.preheader} ${c.heading} ${body(c)}` };
      }),
    );
  it("KYB: only the requested info is shown, never a decision reason", () => {
    const d = "https://dashboard.nearpay.localhost";
    expect(
      body(
        renderContent("kyb.decision", {
          status: "needs_info",
          requested_info: "Send the registry extract",
          dashboard_url: d,
        }),
      ),
    ).toContain("Send the registry extract");
    expect(
      body(renderContent("kyb.decision", { status: "needs_info", requested_info: null, dashboard_url: d })),
    ).toContain("See the dashboard for what is missing.");
    // a message queued before Stage 2 still renders; its `reason` is dropped
    expect(
      body(renderContent("kyb.decision", { status: "needs_info", reason: "INTERNAL", dashboard_url: d })),
    ).not.toContain("INTERNAL");
    // open onboarding (ADR-0024): the approval mail is the "You're live" welcome
    const live = renderContent("kyb.decision", { status: "approved", dashboard_url: d });
    expect(live.subject).toBe("You're live on NearPay");
    expect(live.heading).toBe("You're live — you can accept real payments");
    expect(renderContent("kyb.decision", { status: "rejected", dashboard_url: d }).blocks).not.toContainEqual(
      expect.objectContaining({ kind: "button" }),
    );
  });
  it("KYB is self-declared: no mail claims a verified business or identity (ADR-0020)", () => {
    for (const { t, text } of all()) expect(text, t).not.toMatch(/verif(y|ied|ication)|KYB/i);
    // ADR-0024: no business mail promises or mentions a NearPay review
    for (const t of ["kyb.decision", "kyb.submitted"] as const)
      for (const v of SAMPLES[t]) {
        const c = renderContent(t, v);
        expect(`${c.subject} ${c.preheader} ${c.heading} ${body(c)}`, t).not.toMatch(/review|approv/i);
      }
  });
  it("refund mails never imply NearPay held or returned the funds (INV-1)", () => {
    for (const v of SAMPLES["refund.receipt"]) {
      const text = body(renderContent("refund.receipt", v));
      expect(text).toContain("sent this refund from their own wallet");
      expect(text).not.toMatch(/NearPay (refunded|returned|paid)|your NearPay balance/);
    }
  });
  it("refund receipts show what reached the payer, and what the merchant sent when it differs", () => {
    type V = (typeof SAMPLES)["refund.receipt"][number];
    const [cross, same] = SAMPLES["refund.receipt"] as readonly [V, V];
    const facts = (v: V) =>
      (
        renderContent("refund.receipt", v).blocks.find((b) => b.kind === "facts") as {
          rows: readonly (readonly string[])[];
        }
      ).rows;
    expect(facts(cross)).toEqual(
      expect.arrayContaining([
        ["Amount returned", "24.91 USDT (Arbitrum)"],
        ["Sent by the merchant", "25.00 USDC (Base)"],
        ["Original payment", "25.00 USD"],
      ]),
    );
    expect(facts(same).map((r) => r[0])).toEqual(["Amount returned", "Returned to", "Payment", "Refund"]);
    const sameAmount = { ...cross, received_display: cross.refunded_display };
    expect(facts(sameAmount).map((r) => r[0])).not.toContain("Sent by the merchant");
    expect(renderContent("refund.receipt", same).subject).toBe("Refund from Acme <Test> & Co [test]");
    expect(renderContent("refund.receipt", cross).subject).toBe("Refund from Acme Test Shop");
  });
  it("member mails name who changed what, falling back to ids", () => {
    const [added, invited, removed, changed] = SAMPLES["security.member_changed"];
    expect(body(renderContent("security.member_changed", added))).toContain("Changed by");
    expect(body(renderContent("security.member_changed", invited))).toContain("accepted an invitation");
    expect(body(renderContent("security.member_changed", invited))).not.toContain("Changed by");
    expect(renderContent("security.member_changed", removed).subject).toBe("Security alert: a team member was removed");
    expect(body(renderContent("security.member_changed", changed))).toContain("(was Admin)");
    expect(body(renderContent("security.member_changed", changed))).toContain("usr_01m6pm3ppnengb0aaefsa11e3k");
    const noPrevious = { ...changed, previous_role: null };
    expect(body(renderContent("security.member_changed", noPrevious))).not.toContain("Previous role");
  });
  it("invitation and enrolment mails show the validity and name the account, never the inviter", () => {
    const inv = renderContent("team.invitation", SAMPLES["team.invitation"][0]);
    expect(inv.subject).toBe("You're invited to join Acme Test Shop on NearPay");
    expect(body(inv)).toContain("within 7 days");
    expect(body(inv)).toContain("Finance role");
    expect(body(inv)).not.toContain("@");
    const [admin, op] = SAMPLES["ops.enrolment"];
    expect(body(renderContent("ops.enrolment", admin))).toContain("as Ops admin");
    expect(body(renderContent("ops.enrolment", op))).toContain("within 90 minutes");
  });
  it("destination approval mails show the fingerprint and the approval count", () => {
    const v = SAMPLES["security.destination_approval"][0];
    const text = body(renderContent("security.destination_approval", v));
    expect(text).toContain("7KQ2-M9XA-31");
    expect(text).toContain("2 approvals from different owners or admins (1 so far)");
    expect(body(renderContent("security.destination_approval", { ...v, approvals_required: 1 }))).toContain(
      "1 approval from",
    );
  });
  it("ops approval mails name the action, target and expiry", () => {
    const [suspend, release] = SAMPLES["ops.approval_requested"];
    expect(renderContent("ops.approval_requested", suspend).subject).toBe(
      "[NearPay ops] Approval needed: Suspend account acct_01m6pm3ppnengb0aaefsa11e3j",
    );
    expect(renderContent("ops.approval_requested", release).subject).toBe(
      "[NearPay ops] Approval needed: Release the kill switch",
    );
    expect(body(renderContent("ops.approval_requested", release))).toContain("2026-11-07 11:00 UTC");
    const unknown = { ...suspend, action: "account.close", target_type: "account" };
    expect(renderContent("ops.approval_requested", unknown).subject).toContain("account.close");
  });
  it("the KYB submission mail (queued before ADR-0024) says what happens next", () => {
    const text = body(renderContent("kyb.submitted", SAMPLES["kyb.submitted"][0]));
    expect(text).toContain("2026-11-07 09:30 UTC");
    expect(text).toContain("Test mode keeps working");
  });
  it("security mails always show the destination fingerprint", () => {
    for (const t of [
      "security.destination_pending",
      "security.destination_activated",
      "security.destination_disabled",
    ] as const)
      for (const v of SAMPLES[t]) expect(body(renderContent(t, v)), t).toContain("7KQ2-M9XA-31");
  });
  it("test-mode mails say so", () => {
    const [live, test] = SAMPLES["payment.receipt"];
    expect(renderContent("payment.receipt", live).subject).toBe("Your receipt from Acme Test Shop");
    expect(renderContent("payment.receipt", test).subject).toBe("Your receipt from Acme <Test> & Co [test]");
    expect(body(renderContent("payment.receipt", test))).toContain("Test mode — no real funds moved.");
    expect(body(renderContent("payment.receipt", live))).toContain("YZMN-R81Z-BR");
    expect(body(renderContent("payment.receipt", test))).not.toContain("fingerprint");
    expect(renderContent("review.closed", SAMPLES["review.closed"][0]).subject).toBe(
      "Compliance review closed (test mode)",
    );
    expect(renderContent("review.opened", SAMPLES["review.opened"][0]).subject).toBe(
      "A payment is under compliance review",
    );
  });
  it("names unknown review subjects readably", () => {
    const v = { subject_type: "payout_batch", subject_id: "pb_1", livemode: true, dashboard_url: "https://d.example" };
    expect(renderContent("review.opened", v).subject).toBe("A payout batch is under compliance review");
    expect(renderContent("review.closed", v).preheader).toBe("The review of a payout batch is closed.");
  });
  it("the kill switch mail distinguishes engage from release", () => {
    const [on, off] = SAMPLES["ops.kill_switch"];
    expect(renderContent("ops.kill_switch", on).subject).toContain("ENGAGED");
    expect(renderContent("ops.kill_switch", off).subject).toContain("released");
  });
  it("magic links: one wording per purpose", () => {
    expect(SAMPLES["auth.magic_link"].map((v) => renderContent("auth.magic_link", v).subject)).toEqual([
      "Confirm your email to finish signing up",
      "Your NearPay sign-in link",
      "You have been invited to NearPay",
    ]);
  });
});

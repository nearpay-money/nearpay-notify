import { describe, expect, it } from "vitest";
import {
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

describe("copy rules", () => {
  const body = (c: ReturnType<typeof renderContent>) => JSON.stringify(c.blocks);
  it("KYB: only needs_info shows the reason", () => {
    const d = "https://dashboard.nearpay.localhost";
    expect(
      body(
        renderContent("kyb.decision", { status: "needs_info", reason: "Send the registry extract", dashboard_url: d }),
      ),
    ).toContain("Send the registry extract");
    expect(body(renderContent("kyb.decision", { status: "needs_info", reason: null, dashboard_url: d }))).toContain(
      "Additional documents",
    );
    expect(renderContent("kyb.decision", { status: "approved", reason: null, dashboard_url: d }).subject).toBe(
      "Your business is verified",
    );
    expect(
      renderContent("kyb.decision", { status: "rejected", reason: null, dashboard_url: d }).blocks,
    ).not.toContainEqual(expect.objectContaining({ kind: "button" }));
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
    expect(body(renderContent("payment.receipt", test))).toContain("Test mode: no real funds moved.");
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

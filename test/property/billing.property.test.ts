/**
 * Billing mail properties (step 3.2): amounts are formatted exactly (INV-5), the invoice table adds
 * up to the total, and a customer mail goes out only when every fail-closed check passes.
 */
import { parseUnits } from "@nearpay-internal/money";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  INVOICE_STATUS_FITS,
  type InvoiceTemplate,
  invoiceMail,
  renewalMail,
} from "../../src/domain/message/billing.js";
import { formatAmount, parseVariables, renderContent } from "../../src/domain/template/catalogue.js";
import { SAMPLES } from "../../src/domain/template/samples.js";
import { invoiceContext, subscriptionContext } from "../support/billing.js";

const amount = fc.bigInt({ min: 0n, max: 10n ** 30n });
const decimals = fc.integer({ min: 0, max: 30 });
const symbol = fc.constantFrom("USDC", "NEAR", "wBTC");

describe("amount formatting (INV-5)", () => {
  it("asset amounts round-trip through their display exactly", () => {
    fc.assert(
      fc.property(amount, decimals, symbol, (a, d, s) => {
        const shown = formatAmount(a.toString(), "asset", { symbol: s, decimals: d });
        const [num, sym] = shown.split(" ");
        expect(sym).toBe(s);
        expect(parseUnits(num as string, d)).toBe(a);
      }),
    );
  });
  it("fiat amounts show every minor unit and round-trip", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: Number.MAX_SAFE_INTEGER }),
        fc.constantFrom("usd", "eur", "jpy", "kwd"),
        (a, c) => {
          const [num, code] = formatAmount(a, c, null).split(" ");
          expect(code).toBe(c.toUpperCase());
          const digits = c === "jpy" ? 0 : c === "kwd" ? 3 : 2;
          expect((num as string).split(".")[1]?.length ?? 0).toBe(digits);
          expect(parseUnits(num as string, digits)).toBe(BigInt(a));
        },
      ),
    );
  });
});

describe("invoice table", () => {
  const issued = SAMPLES["invoice.issued"][0];
  it("lines (+ exclusive tax) add up to the total when every line is present", () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 0, max: 1_000_000_000 }), { minLength: 0, maxLength: 19 }),
        fc.integer({ min: 0, max: 1_000_000_000 }),
        (lineAmounts, tax) => {
          const lines = lineAmounts.map((a, i) => ({ description: `Line ${i}`, quantity: 1 + (i % 3), amount: a }));
          const total = lineAmounts.reduce((n, a) => n + a, 0) + tax;
          const v = { ...issued, lines, total, amount_due: total, amount_remaining: total };
          const facts = renderContent("invoice.issued", v).blocks.filter((b) => b.kind === "facts");
          const table = facts[facts.length - 1];
          if (table?.kind !== "facts") throw new Error("no table");
          const cents = (s: string) => parseUnits(s.split(" ")[0] as string, 2);
          const rows = table.rows.slice(0, -1);
          expect(table.rows.at(-1)).toEqual(["Total", formatAmount(total, "usd", null)]);
          expect(rows.reduce((n, [, value]) => n + cents(value), 0n)).toBe(BigInt(total));
          expect(rows.some(([k]) => k === "Tax")).toBe(tax > 0);
        },
      ),
    );
  });
});

describe("fail-closed customer mails", () => {
  const templates = Object.keys(INVOICE_STATUS_FITS) as InvoiceTemplate[];
  it("an invoice mail goes out iff id, mode, recipient, status and link all fit", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...templates),
        fc.constantFrom("draft", "open", "paid", "void", "uncollectible"),
        fc.boolean(),
        fc.constantFrom<boolean | null>(true, false, null),
        fc.boolean(),
        fc.boolean(),
        fc.boolean(),
        (template, status, ctxLive, eventLive, hasEmail, hasLink, sameId) => {
          const ctx = invoiceContext({
            status,
            livemode: ctxLive,
            customer_email: hasEmail ? "c@customer.test" : null,
            ...(hasLink ? {} : { hosted_invoice_url: null }),
            reminder: { number: 1, offset_days: 0, last: false },
          });
          const r = invoiceMail(template, ctx, {
            invoiceId: sameId ? ctx.invoice : "in_someoneelse",
            livemode: eventLive,
            variables: { paid_at: null, voided_at: null },
          });
          const shouldSend =
            sameId &&
            ctxLive === eventLive &&
            hasEmail &&
            INVOICE_STATUS_FITS[template].includes(status) &&
            (hasLink || template === "invoice.paid" || template === "invoice.voided");
          expect("skip" in r).toBe(!shouldSend);
          if (!("skip" in r)) {
            expect(r.to).toBe("c@customer.test");
            expect(r.accountId).toBe(ctx.account_id);
            const v = parseVariables(template, r.variables) as { livemode: boolean };
            expect(v.livemode).toBe(eventLive);
            if (template === "invoice.voided") expect(JSON.stringify(v)).not.toContain("isec_");
          }
        },
      ),
    );
  });
  it("a renewal notice goes out iff id, mode, recipient and a renewing status fit", () => {
    fc.assert(
      fc.property(
        fc.constantFrom("incomplete", "trialing", "active", "past_due", "canceled", "unpaid"),
        fc.boolean(),
        fc.constantFrom<boolean | null>(true, false, null),
        fc.boolean(),
        fc.boolean(),
        fc.boolean(),
        (status, ctxLive, eventLive, hasEmail, cancels, sameId) => {
          const ctx = subscriptionContext({
            status,
            livemode: ctxLive,
            customer_email: hasEmail ? "c@customer.test" : null,
            cancel_at_period_end: cancels,
          });
          const r = renewalMail(ctx, {
            subscriptionId: sameId ? ctx.subscription : "sub_someoneelse",
            livemode: eventLive,
            variables: {},
          });
          const shouldSend =
            sameId &&
            ctxLive === eventLive &&
            hasEmail &&
            !cancels &&
            ["trialing", "active", "past_due"].includes(status);
          expect("skip" in r).toBe(!shouldSend);
          if (!("skip" in r)) expect(() => parseVariables("subscription.renewal_upcoming", r.variables)).not.toThrow();
        },
      ),
    );
  });
});

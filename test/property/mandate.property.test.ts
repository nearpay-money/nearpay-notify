/**
 * Mandate mail properties (Stage 4): a payer mail goes out exactly when every fail-closed check
 * passes, the token amounts reach the template untouched (INV-5), and the mail never points the
 * payer at another contract than the mandate's vault.
 */
import { parseUnits } from "@nearpay-internal/money";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  MANDATE_FITS,
  MANDATE_TEMPLATES,
  type MandateTemplate,
  mandateMail,
} from "../../src/domain/message/mandate.js";
import { formatAmount, parseVariables, renderContent } from "../../src/domain/template/catalogue.js";
import { mandateContext, VAULT, vaultTx } from "../support/billing.js";

const templates = fc.constantFrom(...(Object.values(MANDATE_TEMPLATES) as MandateTemplate[]));
const units = fc.bigInt({ min: 0n, max: 10n ** 30n }).map(String);
const tx = (method: "cancel" | "withdraw") =>
  fc
    .constantFrom<"ok" | "none" | "foreign" | "wrong_method" | "other_signer">(
      "ok",
      "none",
      "foreign",
      "wrong_method",
      "other_signer",
    )
    .map((k) => {
      if (k === "none") return { kind: k, tx: null };
      if (k === "foreign") return { kind: k, tx: vaultTx(method, 7, "evil.near") };
      if (k === "wrong_method") return { kind: k, tx: vaultTx(method === "cancel" ? "withdraw" : "cancel") };
      if (k === "other_signer") return { kind: k, tx: { ...vaultTx(method), signer_id: "mallory.near" } };
      return { kind: k, tx: vaultTx(method) };
    });

describe("mandateMail", () => {
  it("sends iff mode, email, status, link, transactions and refund all fit", () => {
    fc.assert(
      fc.property(
        templates,
        fc.constantFrom("active", "insufficient", "exhausted", "canceled"),
        fc.constantFrom("linked", "unlinked"),
        fc.boolean(),
        fc.constantFrom<boolean | null>(true, false, null),
        fc.boolean(),
        tx("cancel"),
        tx("withdraw"),
        fc.option(units, { nil: null }),
        units,
        units,
        (t, status, link, ctxLive, eventLive, hasEmail, cancel, withdraw, refunded, per, balance) => {
          const ctx = mandateContext({
            status,
            link_status: link,
            livemode: ctxLive,
            customer_email: hasEmail ? "payer@customer.test" : null,
            cancel_transaction: cancel.tx,
            withdraw_transaction: withdraw.tx,
            refunded,
            amount_per_period: per,
            balance,
          });
          const r = mandateMail(t, ctx, {
            mandateId: ctx.mandate,
            subscriptionId: ctx.subscription,
            livemode: eventLive,
            variables: {},
          });
          const fit = MANDATE_FITS[t];
          const ok =
            ctxLive === eventLive &&
            hasEmail &&
            fit.statuses.includes(status) &&
            (!fit.link || fit.link === link) &&
            (cancel.kind === "ok" || cancel.kind === "none") &&
            (withdraw.kind === "ok" || withdraw.kind === "none") &&
            (!fit.needsCancel || cancel.kind === "ok") &&
            (t !== "mandate.canceled" || refunded !== null);
          expect("skip" in r).toBe(!ok);
          if ("skip" in r) return;
          const v = r.variables as Record<string, unknown>;
          // INV-5: amounts travel as billing sent them
          expect(v.amount_per_period).toBe(per);
          expect(v.balance).toBe(balance);
          if (t === "mandate.canceled") expect(v.refunded).toBe(refunded);
          // only the mandate's own vault is ever shown as a contract to call
          for (const c of [v.cancel_call, v.withdraw_call])
            if (c) expect((c as { contract: string }).contract).toBe(VAULT);
          // the catalogue accepts it and it renders
          expect(() => renderContent(t, parseVariables(t, v))).not.toThrow();
        },
      ),
    );
  });

  it("token amounts round-trip through their display exactly", () => {
    fc.assert(
      fc.property(units, fc.integer({ min: 0, max: 30 }), (a, d) => {
        const [num, sym] = formatAmount(a, "asset", { symbol: "USDC", decimals: d }).split(" ");
        expect(sym).toBe("USDC");
        expect(parseUnits(num as string, d).toString()).toBe(a);
      }),
    );
  });
});

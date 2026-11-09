/**
 * Mandate mails to the payer (lld/notify.md §4, Stage 4): billing's mandate notification context →
 * recipient and template variables. Pure.
 *
 * Mandate events carry the public `Mandate` (no email); the customer's email, the merchant name,
 * the payer's `cancel`/`withdraw` transactions and the hosted invoice link (with the invoice
 * secret) come from billing's `notification-context`, read when the `event.notify` job runs. The
 * context is the authority on what is still true, and every check fails closed (nothing is sent):
 *
 * - the context names another mandate or subscription than the event;
 * - its `livemode` differs from the event's (a sandbox-vault mandate never mails as live);
 * - `customer_email` is null;
 * - the status no longer fits the mail (e.g. an activation or release notice for a mandate the
 *   payer has canceled meanwhile, an insufficient-funds notice after a top-up);
 * - a mail that must tell the payer how to cancel has no cancel transaction (FR-BIL-04);
 * - a transaction billing hands over does not call the mandate's own vault with the expected
 *   method, or names another signer than the payer (the mail would send the payer elsewhere).
 *
 * Amounts stay integers (INV-5): token base units as billing sends them, with the token's symbol
 * and decimals, formatted only by the template.
 */
import type { MandateNotificationContext } from "@nearpay-internal/spec";
import type { z } from "zod";
import type { TemplateName } from "../template/catalogue.js";
import type { CustomerMail, MailOrSkip } from "./billing.js";

export type MandateContext = z.output<typeof MandateNotificationContext>;
export type MandateTemplate = Extract<TemplateName, `mandate.${string}`>;

/** Billing subject → mandate template (spec `BILLING_EMAIL_TEMPLATES`, contract-tested). */
export const MANDATE_TEMPLATES = {
  "evt.billing.mandate.activated": "mandate.activated",
  "evt.billing.mandate.insufficient_funds": "mandate.insufficient_funds",
  "evt.billing.mandate.canceled": "mandate.canceled",
  "evt.billing.mandate.unlinked": "mandate.unlinked",
  "evt.billing.mandate.released": "mandate.released",
} as const satisfies Record<string, MandateTemplate>;

/** On-chain active statuses (the payer can still cancel). */
const ONCHAIN_ACTIVE: readonly string[] = ["active", "insufficient"];

/** What each mail needs from the context, or the reason it no longer fits. */
export const MANDATE_FITS: {
  readonly [T in MandateTemplate]: {
    readonly statuses: readonly string[];
    readonly link?: "linked" | "unlinked";
    readonly needsCancel: boolean;
  };
} = {
  // FR-BIL-04: the confirmation always shows how to cancel
  "mandate.activated": { statuses: ONCHAIN_ACTIVE, link: "linked", needsCancel: true },
  // a top-up meanwhile (`active`) or a cancel makes the request moot
  "mandate.insufficient_funds": { statuses: ["insufficient"], link: "linked", needsCancel: false },
  "mandate.canceled": { statuses: ["canceled"], needsCancel: false },
  // the payer gets the funds back only by cancelling: without that call there is nothing to ask
  "mandate.unlinked": { statuses: ONCHAIN_ACTIVE, link: "unlinked", needsCancel: true },
  "mandate.released": { statuses: ONCHAIN_ACTIVE, needsCancel: true },
};

type Tx = NonNullable<MandateContext["cancel_transaction"]>;

/** A payer transaction as the mail shows it (one function call on the vault). */
export interface NearCall {
  readonly contract: string;
  readonly method: string;
  readonly args_json: string;
  readonly deposit_yocto: string;
  readonly gas: string;
}

/** The single call of a payer transaction, or null when it is not `method` on `vault` signed by `payer`. */
export function payerCall(tx: Tx, vault: string, method: string, payer: string): NearCall | null {
  const [a, ...more] = tx.actions;
  if (!a || more.length > 0 || tx.receiver_id !== vault || a.method_name !== method) return null;
  if (tx.signer_id !== null && tx.signer_id !== payer) return null;
  return {
    contract: tx.receiver_id,
    method: a.method_name,
    args_json: JSON.stringify(a.args),
    deposit_yocto: a.deposit,
    gas: a.gas,
  };
}

export function mandateMail(
  template: MandateTemplate,
  ctx: MandateContext,
  expected: {
    readonly mandateId: string;
    readonly subscriptionId: string;
    readonly livemode: boolean | null;
    readonly variables: Readonly<Record<string, unknown>>;
  },
): MailOrSkip {
  if (ctx.mandate !== expected.mandateId) return { skip: "billing answered for another mandate" };
  if (ctx.subscription !== expected.subscriptionId) return { skip: "billing names another subscription" };
  if (ctx.livemode !== expected.livemode) return { skip: "billing reports another mode" };
  if (!ctx.customer_email) return { skip: "the customer has no email on record" };
  const fit = MANDATE_FITS[template];
  if (!fit.statuses.includes(ctx.status))
    return { skip: `the mandate is ${ctx.status} now (${template} no longer fits)` };
  if (fit.link && ctx.link_status !== fit.link)
    return { skip: `the mandate is ${ctx.link_status} now (${template} no longer fits)` };
  const cancel = ctx.cancel_transaction
    ? payerCall(ctx.cancel_transaction, ctx.vault_contract, "cancel", ctx.payer)
    : null;
  if (ctx.cancel_transaction && !cancel) return { skip: "the cancel transaction does not call the mandate's vault" };
  const withdraw = ctx.withdraw_transaction
    ? payerCall(ctx.withdraw_transaction, ctx.vault_contract, "withdraw", ctx.payer)
    : null;
  if (ctx.withdraw_transaction && !withdraw)
    return { skip: "the withdraw transaction does not call the mandate's vault" };
  if (fit.needsCancel && !cancel) return { skip: "billing returned no cancel transaction" };
  if (template === "mandate.canceled" && ctx.refunded === null) return { skip: "billing reports no refund amount" };
  const mail: CustomerMail = {
    to: ctx.customer_email,
    accountId: ctx.account_id,
    variables: {
      ...expected.variables,
      mandate_id: ctx.mandate,
      subscription_id: ctx.subscription,
      merchant_name: ctx.merchant_display_name,
      customer_name: ctx.customer_name,
      livemode: ctx.livemode,
      payer: ctx.payer,
      vault_contract: ctx.vault_contract,
      onchain_id: ctx.onchain_id,
      token: { symbol: ctx.token_asset.symbol, decimals: ctx.token_asset.decimals },
      amount_per_period: ctx.amount_per_period,
      interval: ctx.recurring?.interval ?? null,
      interval_count: ctx.recurring?.interval_count ?? null,
      balance: ctx.balance,
      next_collect_at: ctx.next_collect_at,
      cancel_call: cancel,
      withdraw_call: withdraw,
      // the link carries the invoice secret: it lives only in the encrypted variables until sent
      manage_url: ctx.manage_url,
      ...(template === "mandate.insufficient_funds" ? { invoice_id: ctx.invoice } : {}),
      ...(template === "mandate.canceled" ? { refunded: ctx.refunded } : {}),
      ...(template === "mandate.unlinked" ? { unlinked_reason: ctx.unlinked_reason } : {}),
    },
  };
  return mail;
}

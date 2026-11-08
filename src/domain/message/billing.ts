/**
 * Billing mails (lld/notify.md §4, step 3.2): billing's notification context → recipient and
 * template variables. Pure.
 *
 * Billing events carry ids only; the customer's email, the merchant name and the hosted invoice
 * link (which embeds the invoice secret) come from billing's `notification-context`, read when the
 * `event.notify` job runs. Because that read happens later than the event, the context is the
 * authority on what is still true, and every check fails closed (nothing is sent):
 *
 * - the context names another invoice or subscription than the event;
 * - its `livemode` differs from the event's (a test object never mails as live);
 * - `customer_email` is null (no recipient on record);
 * - the status no longer fits the mail (e.g. a reminder for an invoice paid meanwhile, an
 *   "issued" mail for an invoice voided meanwhile, a renewal notice for a subscription that will
 *   cancel at the period end);
 * - a mail whose purpose is the payment link has no link (billing returns none for void invoices).
 *
 * Amounts stay integers (INV-5): they travel as billing sends them (fiat minor units or asset base
 * units) with the asset's symbol and decimals, and are formatted only by the template.
 */
import type { InvoiceNotificationContext, SubscriptionNotificationContext } from "@nearpay-internal/spec";
import type { z } from "zod";
import type { TemplateName } from "../template/catalogue.js";

export type InvoiceContext = z.output<typeof InvoiceNotificationContext>;
export type SubscriptionContext = z.output<typeof SubscriptionNotificationContext>;

export type InvoiceTemplate = Extract<TemplateName, `invoice.${string}`>;

/** Invoice statuses each mail still fits (an `uncollectible` invoice can still be paid, INV-3). */
export const INVOICE_STATUS_FITS: { readonly [T in InvoiceTemplate]: readonly string[] } = {
  "invoice.issued": ["open", "uncollectible"],
  "invoice.reminder": ["open", "uncollectible"],
  "invoice.paid": ["paid"],
  "invoice.voided": ["void"],
};

/** Mails whose purpose is the hosted payment link: without it there is nothing to send. */
const NEEDS_LINK: ReadonlySet<InvoiceTemplate> = new Set(["invoice.issued", "invoice.reminder"]);

/** Subscription statuses that renew (`unpaid` creates no invoices; `canceled`/`incomplete` never renew). */
export const RENEWING_STATUSES: readonly string[] = ["active", "trialing", "past_due"];

export interface CustomerMail {
  readonly to: string;
  /** Prefixed account id (`acct_…`) the message is filed under. */
  readonly accountId: string;
  readonly variables: Record<string, unknown>;
}

export type MailOrSkip = CustomerMail | { readonly skip: string };

/** Receipt data of the paying intent (payments `receipt-context`), for `invoice.paid`. */
export interface PaidReceipt {
  readonly settled_display: string;
  readonly evidence_links: readonly string[];
}

const asset = (a: InvoiceContext["pricing_asset"]) => (a ? { symbol: a.symbol, decimals: a.decimals } : null);

/** The checks every customer mail shares; null = go. */
function common(ctx: { livemode: boolean; customer_email: string | null }, livemode: boolean | null): string | null {
  // the event's mode is the one billing published; a context in another mode is never mailed
  if (ctx.livemode !== livemode) return "billing reports another mode";
  if (!ctx.customer_email) return "the customer has no email on record";
  return null;
}

export function invoiceMail(
  template: InvoiceTemplate,
  ctx: InvoiceContext,
  expected: {
    readonly invoiceId: string;
    readonly livemode: boolean | null;
    readonly variables: Readonly<Record<string, unknown>>;
    readonly receipt?: PaidReceipt | null;
  },
): MailOrSkip {
  if (ctx.invoice !== expected.invoiceId) return { skip: "billing answered for another invoice" };
  const no = common(ctx, expected.livemode);
  if (no) return { skip: no };
  if (!INVOICE_STATUS_FITS[template].includes(ctx.status))
    return { skip: `the invoice is ${ctx.status} now (${template} no longer fits)` };
  if (NEEDS_LINK.has(template) && !ctx.hosted_invoice_url) return { skip: "billing returned no hosted invoice link" };
  const reminder = ctx.reminder ?? (expected.variables.reminder as InvoiceContext["reminder"] | undefined) ?? null;
  if (template === "invoice.reminder" && reminder === null) return { skip: "no reminder details" };
  return {
    to: ctx.customer_email as string,
    accountId: ctx.account_id,
    variables: {
      ...expected.variables,
      invoice_id: ctx.invoice,
      number: ctx.number,
      merchant_name: ctx.merchant_display_name,
      customer_name: ctx.customer_name,
      livemode: ctx.livemode,
      currency: ctx.currency,
      asset: asset(ctx.pricing_asset),
      total: ctx.total,
      amount_due: ctx.amount_due,
      amount_remaining: ctx.amount_remaining,
      due_date: ctx.due_date,
      period_start: ctx.period_start,
      period_end: ctx.period_end,
      subscription_id: ctx.subscription,
      lines: ctx.lines
        .slice(0, 20)
        .map((l) => ({ description: l.description, quantity: l.quantity, amount: l.amount })),
      // the voided mail's schema has no link field, so a link never reaches it
      hosted_invoice_url: ctx.hosted_invoice_url,
      ...(template === "invoice.reminder" ? { reminder } : {}),
      ...(template === "invoice.paid"
        ? {
            payment_id: ctx.payment_intent,
            settled_display: expected.receipt?.settled_display ?? null,
            evidence_links: (expected.receipt?.evidence_links ?? []).slice(0, 10),
          }
        : {}),
    },
  };
}

export function renewalMail(
  ctx: SubscriptionContext,
  expected: {
    readonly subscriptionId: string;
    readonly livemode: boolean | null;
    readonly variables: Readonly<Record<string, unknown>>;
  },
): MailOrSkip {
  if (ctx.subscription !== expected.subscriptionId) return { skip: "billing answered for another subscription" };
  const no = common(ctx, expected.livemode);
  if (no) return { skip: no };
  if (ctx.cancel_at_period_end) return { skip: "the subscription ends at the period end" };
  if (!RENEWING_STATUSES.includes(ctx.status)) return { skip: `the subscription is ${ctx.status}` };
  return {
    to: ctx.customer_email as string,
    accountId: ctx.account_id,
    variables: {
      ...expected.variables,
      subscription_id: ctx.subscription,
      merchant_name: ctx.merchant_display_name,
      customer_name: ctx.customer_name,
      livemode: ctx.livemode,
      trialing: ctx.status === "trialing",
      renews_at: ctx.renews_at,
      interval: ctx.recurring.interval,
      interval_count: ctx.recurring.interval_count,
      currency: ctx.currency,
      asset: asset(ctx.pricing_asset),
      next_amount: ctx.next_amount,
      items: ctx.items.slice(0, 20).map((i) => ({ description: i.description, quantity: i.quantity })),
    },
  };
}

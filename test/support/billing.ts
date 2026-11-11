/**
 * Spec-valid billing objects for tests (kit 0.2.1 has no billing factories): invoice and
 * subscription events, stage 4 mandates, and billing's notification contexts — each parsed against
 * spec 0.4.0.
 */

import { newId } from "@nearpay-internal/ids";
import {
  InvoiceNotificationContext,
  InvoiceReminderEvent,
  MandateNotificationContext,
  SubscriptionNotificationContext,
} from "@nearpay-internal/spec";
import { Invoice, Mandate, Subscription } from "@nearpay-money/spec";
import type { z } from "zod";

type Over<T> = Partial<Record<keyof T, unknown>>;
const now = () => Math.floor(Date.now() / 1000);

export function invoice(over: Over<Invoice> = {}): Invoice {
  const t = now();
  const id = (over.id as string | undefined) ?? newId("in");
  return Invoice.parse({
    id,
    object: "invoice",
    created: t - 3600,
    livemode: true,
    status: "open",
    number: "ACMESH-L-00042",
    customer: newId("cus"),
    subscription: null,
    billing_reason: "manual",
    collection_method: "send_invoice",
    currency: "usd",
    asset_id: null,
    description: null,
    footer: null,
    lines: [],
    default_tax_rates: [],
    subtotal: 9900,
    tax: 990,
    total: 10890,
    total_excluding_tax: 9900,
    total_tax_amounts: [],
    amount_due: 10890,
    amount_paid: 0,
    amount_remaining: 10890,
    days_until_due: 7,
    due_date: t + 7 * 86400,
    period_start: null,
    period_end: null,
    settlement_destination: null,
    reminder_days: [-3, 0, 1, 3, 7],
    reminders_sent: 0,
    next_reminder_at: null,
    hosted_invoice_url: null,
    invoice_pdf: null,
    checkout_session: null,
    payment_intent: null,
    payment_intents: [],
    status_transitions: {
      finalized_at: t - 3000,
      sent_at: t - 2000,
      paid_at: null,
      voided_at: null,
      marked_uncollectible_at: null,
    },
    uncollectible_reason: null,
    metadata: {},
    sequence: 3,
    ...over,
  });
}

export function reminderEvent(over: Over<z.output<typeof InvoiceReminderEvent>> = {}) {
  return InvoiceReminderEvent.parse({
    invoice: newId("in"),
    customer: newId("cus"),
    subscription: null,
    number: 2,
    offset_days: 0,
    due_date: new Date().toISOString(),
    last: false,
    ...over,
  });
}

export function subscription(over: Over<Subscription> = {}): Subscription {
  const t = now();
  return Subscription.parse({
    id: newId("sub"),
    object: "subscription",
    created: t - 86400 * 27,
    livemode: true,
    status: "active",
    customer: newId("cus"),
    items: [],
    collection_method: "send_invoice",
    days_until_due: 7,
    currency: "usd",
    asset_id: null,
    default_tax_rates: [],
    recurring: { interval: "month", interval_count: 1 },
    current_period_start: t - 86400 * 27,
    current_period_end: t + 86400 * 3,
    billing_cycle_anchor: t - 86400 * 27,
    trial_start: null,
    trial_end: null,
    cancel_at_period_end: false,
    canceled_at: null,
    ended_at: null,
    cancellation_reason: null,
    latest_invoice: null,
    settlement_destination: null,
    dunning: { reminder_days: [-3, 0, 1, 3, 7], on_exhausted: "cancel" },
    description: null,
    metadata: {},
    sequence: 1,
    ...over,
  });
}

export type InvoiceCtx = z.output<typeof InvoiceNotificationContext>;
export type SubscriptionCtx = z.output<typeof SubscriptionNotificationContext>;

export function invoiceContext(over: Over<InvoiceCtx> = {}): InvoiceCtx {
  const invoiceId = (over.invoice as string | undefined) ?? newId("in");
  return InvoiceNotificationContext.parse({
    account_id: newId("acct"),
    livemode: true,
    merchant_display_name: "Acme Test Shop",
    customer: newId("cus"),
    customer_email: "dana@customer.test",
    customer_name: "Dana Whitfield",
    invoice: invoiceId,
    number: "ACMESH-L-00042",
    status: "open",
    currency: "usd",
    asset_id: null,
    pricing_asset: null,
    total: 10890,
    amount_due: 10890,
    amount_remaining: 10890,
    due_date: "2026-11-15T00:00:00.000Z",
    period_start: null,
    period_end: null,
    subscription: null,
    lines: [
      { description: "Pro plan (monthly)", quantity: 1, amount: 7900 },
      { description: "Extra seat", quantity: 2, amount: 2000 },
    ],
    hosted_invoice_url: `https://pay.nearpay.localhost/i/${invoiceId}#isec_TESTSECRET_${invoiceId.slice(-6)}`,
    payment_intent: null,
    reminder: null,
    ...over,
  });
}

export function subscriptionContext(over: Over<SubscriptionCtx> = {}): SubscriptionCtx {
  return SubscriptionNotificationContext.parse({
    account_id: newId("acct"),
    livemode: true,
    merchant_display_name: "Acme Test Shop",
    customer: newId("cus"),
    customer_email: "dana@customer.test",
    customer_name: "Dana Whitfield",
    subscription: newId("sub"),
    status: "active",
    renews_at: "2026-12-01T00:00:00.000Z",
    recurring: { interval: "month", interval_count: 1 },
    currency: "usd",
    asset_id: null,
    pricing_asset: null,
    next_amount: 10890,
    items: [{ description: "Pro plan", quantity: 1 }],
    cancel_at_period_end: false,
    ...over,
  });
}

// stage 4 — mandates (spec 0.4.0)
export const VAULT = "v1.vault.nearpay.near";
const TOKEN = "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";

export function mandate(over: Over<Mandate> = {}): Mandate {
  const t = now();
  return Mandate.parse({
    id: newId("md"),
    object: "mandate",
    created: t - 600,
    livemode: true,
    status: "active",
    link_status: "linked",
    unlinked_reason: null,
    collecting: true,
    subscription: newId("sub"),
    customer: newId("cus"),
    vault_contract: VAULT,
    onchain_id: 7,
    payer: "dana.near",
    token: TOKEN,
    asset_id: `nep141:${TOKEN}`,
    merchant_receiver: "acme.near",
    receiver_kind: "intents_account",
    settlement_destination: newId("sd"),
    amount_per_period: "25000000",
    period_secs: 2_629_746,
    start_at: t - 600,
    max_periods: null,
    fee_bps: 100,
    collected_periods: 1,
    balance: "50000000",
    funded_periods: 2,
    next_collect_at: t + 2_629_146,
    last_collection: null,
    collect_failures: 0,
    canceled: null,
    withdrawn: "0",
    ext_ref: "sub_x",
    sequence: 2,
    ...over,
  });
}

export type MandateCtx = z.output<typeof MandateNotificationContext>;

/** The payer's vault call as billing prepares it (100 Tgas, 1 yoctoNEAR). */
export const vaultTx = (method: "cancel" | "withdraw", onchainId = 7, vault = VAULT) => ({
  signer_id: null,
  receiver_id: vault,
  actions: [
    {
      type: "FunctionCall" as const,
      method_name: method,
      args: { mandate_id: onchainId },
      gas: "100000000000000",
      deposit: "1",
    },
  ],
});

export function mandateContext(over: Over<MandateCtx> = {}): MandateCtx {
  const mandateId = (over.mandate as string | undefined) ?? newId("md");
  const invoiceId = newId("in");
  return MandateNotificationContext.parse({
    account_id: newId("acct"),
    livemode: true,
    merchant_display_name: "Acme Test Shop",
    customer: newId("cus"),
    customer_email: "dana@customer.test",
    customer_name: "Dana Whitfield",
    mandate: mandateId,
    subscription: newId("sub"),
    status: "active",
    link_status: "linked",
    unlinked_reason: null,
    payer: "dana.near",
    vault_contract: VAULT,
    onchain_id: 7,
    token_asset: { asset_id: `nep141:${TOKEN}`, symbol: "USDC", decimals: 6 },
    amount_per_period: "25000000",
    recurring: { interval: "month", interval_count: 1 },
    balance: "50000000",
    next_collect_at: "2026-12-01T00:00:00.000Z",
    refunded: null,
    cancel_transaction: vaultTx("cancel"),
    withdraw_transaction: null,
    invoice: null,
    manage_url: `https://pay.nearpay.localhost/i/${invoiceId}#isec_TESTSECRET_${invoiceId.slice(-6)}`,
    ...over,
  });
}

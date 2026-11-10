/**
 * Template catalogue (lld/notify.md §4). Each template validates its variables (zod) and renders
 * localized content blocks. Pure. Variables never carry secrets beyond what the mail must show (a
 * magic link is the one exception: it IS the message); recipients are resolved by the caller.
 *
 * Copy rules: security mails always show the destination fingerprint (security.md T-01); mails to
 * merchants never repeat internal compliance reasons (only a `needs_info` request is shown); KYB is
 * self-declared business details (ADR-0020 d3) that go live at once without a NearPay review
 * (open onboarding, ADR-0024: the approval mail is the "You're live" welcome, no "we're reviewing" mail),
 * so no mail ever claims a verified business or identity, or a review (product/design-system.md §6.3); refund mails say the merchant sent
 * the funds from their own wallet (INV-1: NearPay never holds or returns funds itself).
 */
import { formatUnits, minorUnits } from "@nearpay-internal/money";
import { z } from "zod";
import type { Block, Content } from "./blocks.js";

export const LOCALES = ["en"] as const;
export type Locale = (typeof LOCALES)[number];

/** Supported locale for a requested one (`en-GB` → `en`; unknown → `en`). */
export function resolveLocale(requested: string | null | undefined): Locale {
  const base = (requested ?? "").toLowerCase().split(/[-_]/)[0];
  return (LOCALES as readonly string[]).includes(base ?? "") ? (base as Locale) : "en";
}

const url = z.url({ protocol: /^https?$/ });
const ROLES = ["owner", "admin", "developer", "finance", "support", "viewer"] as const;
const OPS_ROLES = ["ops", "ops_admin"] as const;
/** Priced amount: fiat minor units (integer) or asset base units (decimal string); INV-5, never a float. */
const pricingAmount = z.union([z.int().min(0), z.string().regex(/^\d{1,78}$/)]);
const pricingCurrency = z.string().regex(/^([a-z]{3}|asset)$/);
const text = (max = 500) => z.string().min(1).max(max);
const iso = z.iso.datetime({ offset: true });

/** Display data of the pricing asset (`currency: asset`); null for fiat. */
const assetDisplay = z.object({ symbol: text(32), decimals: z.int().min(0).max(255) }).nullable();

/**
 * Priced amounts of a billing mail: fiat in integer minor units, assets in base-unit strings with
 * the asset's display data (INV-5). The pairing is checked so a mail never formats one as the other.
 */
function pricedAmounts<S extends z.ZodRawShape>(shape: S, amountKeys: readonly string[]) {
  return z.object({ currency: pricingCurrency, asset: assetDisplay, ...shape }).superRefine((v, ctx) => {
    const rec = v as Record<string, unknown>;
    const isAsset = rec.currency === "asset";
    if (isAsset && rec.asset === null)
      ctx.addIssue({ code: "custom", path: ["asset"], message: "asset pricing needs the asset's display data" });
    const amounts: [string, unknown][] = amountKeys.map((k) => [k, rec[k]]);
    for (const [i, l] of ((rec.lines as { amount: unknown }[] | undefined) ?? []).entries())
      amounts.push([`lines.${i}.amount`, l.amount]);
    for (const [k, a] of amounts)
      if (isAsset ? typeof a !== "string" : typeof a !== "number")
        ctx.addIssue({
          code: "custom",
          path: k.split("."),
          message: isAsset ? "asset amounts are base-unit strings" : "fiat amounts are integer minor units",
        });
  });
}

const invoiceLine = z.object({ description: text(500), quantity: z.int().min(1), amount: pricingAmount });
const invoiceFields = {
  invoice_id: text(64),
  number: text(64),
  merchant_name: text(200),
  customer_name: z.string().max(200).nullable(),
  livemode: z.boolean(),
  total: pricingAmount,
  amount_due: pricingAmount,
  amount_remaining: pricingAmount,
  due_date: iso.nullable(),
  period_start: iso.nullable(),
  period_end: iso.nullable(),
  subscription_id: z.string().max(64).nullable(),
  lines: z.array(invoiceLine).max(20),
};
const INVOICE_AMOUNTS = ["total", "amount_due", "amount_remaining"] as const;

/** Token amount in base units (INV-5: a decimal string, never a float). */
const baseUnits = z.string().regex(/^(0|[1-9][0-9]{0,77})$/);
const nearAccount = z.string().regex(/^[a-z0-9._-]{2,64}$/);
/** A payer transaction on the vault (one function call), shown so it can be sent from any wallet. */
const nearCall = z.object({
  contract: nearAccount,
  method: z.enum(["cancel", "withdraw"]),
  args_json: text(500),
  deposit_yocto: z.string().regex(/^(0|[1-9][0-9]{0,38})$/),
  gas: z.string().regex(/^[1-9][0-9]{0,17}$/),
});
const mandateFields = {
  mandate_id: text(64),
  subscription_id: text(64),
  merchant_name: text(200),
  customer_name: z.string().max(200).nullable(),
  livemode: z.boolean(),
  payer: nearAccount,
  vault_contract: nearAccount,
  onchain_id: z.int().min(0),
  token: z.object({ symbol: text(32), decimals: z.int().min(0).max(255) }),
  amount_per_period: baseUnits,
  interval: z.enum(["day", "week", "month", "year"]).nullable(),
  interval_count: z.int().min(1).max(36).nullable(),
  balance: baseUnits,
  next_collect_at: iso.nullable(),
  cancel_call: nearCall.nullable(),
  withdraw_call: nearCall.nullable(),
  /** Hosted invoice page with the invoice secret (a bearer link: wiped once sent). */
  manage_url: url.nullable(),
};

const destination = z.object({
  label: z.string().max(100).nullable(),
  chain: text(64),
  chain_name: text(64),
  address: text(256),
  asset_id: text(256),
  fingerprint: text(32),
  dashboard_url: url,
});

const SCHEMAS = {
  "auth.magic_link": z.object({
    link_url: url,
    purpose: z.enum(["signup", "recovery", "invite"]),
    expires_in_minutes: z.int().min(1).max(1440),
  }),
  "account.welcome": z.object({ account_name: text(200), dashboard_url: url }),
  "security.destination_pending": destination.extend({
    active_at: iso.nullable(),
    /** No cool-off wait (configurable; 0 in the beta). Absent on jobs queued before it existed. */
    active_now: z.boolean().optional(),
  }),
  "security.destination_activated": destination,
  "security.destination_disabled": destination.extend({ disabled_reason: z.string().max(200).nullable() }),
  "security.destination_blocked": z.object({ destination_id: text(64), dashboard_url: url }),
  "kyb.decision": z.object({
    status: z.enum(["approved", "rejected", "needs_info"]),
    /**
     * What ops asked for (`needs_info` only; the event's `requested_info`). Never the decision
     * `reason`, which is internal. Messages queued before Stage 2 carried `reason`: it is dropped.
     */
    requested_info: z.string().max(1000).nullable().default(null),
    dashboard_url: url,
  }),
  "account.suspended": z.object({ dashboard_url: url }),
  "account.reinstated": z.object({ dashboard_url: url }),
  "review.opened": z.object({
    subject_type: text(64),
    subject_id: text(64),
    livemode: z.boolean(),
    dashboard_url: url,
  }),
  "review.closed": z.object({
    subject_type: text(64),
    subject_id: text(64),
    livemode: z.boolean(),
    dashboard_url: url,
  }),
  "payment.receipt": z.object({
    payment_id: text(64),
    merchant_name: text(200),
    amount: pricingAmount,
    currency: pricingCurrency,
    settled_display: text(200),
    /** Fingerprint of the destination the payment settled to (security.md T-01: shown on every receipt). */
    destination_fingerprint: z.string().max(32).nullable(),
    evidence_links: z.array(url).max(10),
    livemode: z.boolean(),
  }),
  "ops.kill_switch": z.object({ engaged: z.boolean(), reason: text(500), actor: text(200) }),
  "ops.audit_finding": z.object({
    finding_id: text(64),
    execution_id: text(64),
    account_id: text(64),
    check_kind: text(100),
    result: text(64),
  }),
  "webhooks.endpoint_disabled": z.object({
    endpoint_id: text(64),
    url: url,
    failing_since: iso,
    dashboard_url: url,
  }),
  // stage 2 (lld/notify.md §4, step 2.2)
  "refund.receipt": z.object({
    refund_id: text(64),
    payment_id: text(64),
    merchant_name: text(200),
    original_amount: pricingAmount,
    original_currency: pricingCurrency,
    /** What the merchant sent (settlement asset), e.g. `25.00 USDC (Base)`. */
    refunded_display: text(200),
    /** What reached the payer (their asset), from evidence; null when not known. */
    received_display: z.string().max(200).nullable(),
    /** Shortened refund address and chain, e.g. `0xab…cd on Base`. */
    recipient_display: text(200),
    evidence_links: z.array(url).max(10),
    livemode: z.boolean(),
  }),
  "security.member_changed": z.object({
    change: z.enum(["added", "removed", "role_changed"]),
    member_id: text(64),
    /** Resolved through identity's recipients (`?user=` since spec 0.2.1: any role, recently removed); else null. */
    member_email: z.string().max(254).nullable(),
    role: z.enum(ROLES),
    previous_role: z.enum(ROLES).nullable(),
    /** Owner/admin who made the change; null when the member accepted an invitation. */
    actor_id: z.string().max(64).nullable(),
    actor_email: z.string().max(254).nullable(),
    dashboard_url: url,
  }),
  "team.invitation": z.object({
    link_url: url,
    account_display_name: text(100),
    role: z.enum(ROLES),
    expires_in_minutes: z.int().min(1).max(10_080),
  }),
  "ops.enrolment": z.object({
    link_url: url,
    role: z.enum(OPS_ROLES),
    expires_in_minutes: z.int().min(1).max(1440),
  }),
  "security.destination_approval": destination.extend({
    approvals_required: z.int().min(1).max(2),
    approvals_received: z.int().min(0).max(2),
  }),
  "kyb.submitted": z.object({ submitted_at: iso, dashboard_url: url }),
  "ops.approval_requested": z.object({
    approval_id: text(64),
    action: text(64),
    target_type: text(64),
    target_id: text(128),
    /** Requester's reason: shown to ops contacts only (never to merchants). */
    reason: text(500),
    requested_by: text(64),
    requested_by_role: z.enum(OPS_ROLES),
    requested_at: iso,
    expires_at: iso,
    console_url: url,
  }),
  // spec 0.2.1 (lld/notify.md §"Spec 0.2.1 contract changes")
  "security.recovery": z.object({
    user_id: text(64),
    /** The recovered user, named through identity's recipients; null when not listed. */
    user_email: z.string().max(254).nullable(),
    recovered_at: iso,
    lock_until: iso,
    dashboard_url: url,
  }),
  "webhooks.secret_rotated": z.object({
    endpoint_id: text(64),
    url: url,
    /** Until when the previous secret still signs; null when it was dropped at once. Never a secret. */
    previous_secret_expires_at: iso.nullable(),
    actor_id: z.string().max(64).nullable(),
    actor_email: z.string().max(254).nullable(),
    livemode: z.boolean(),
    dashboard_url: url,
  }),
  // stage 3 — billing (lld/notify.md §4, spec 0.3.0 `BILLING_EMAIL_TEMPLATES`); recipient: the customer
  "invoice.issued": pricedAmounts(
    {
      ...invoiceFields,
      /** Hosted invoice page with the invoice secret in the fragment (a bearer link: wiped once sent). */
      hosted_invoice_url: url,
    },
    INVOICE_AMOUNTS,
  ),
  "invoice.reminder": pricedAmounts(
    {
      ...invoiceFields,
      hosted_invoice_url: url,
      reminder: z.object({ number: z.int().min(1).max(10), offset_days: z.int().min(-30).max(60), last: z.boolean() }),
    },
    INVOICE_AMOUNTS,
  ),
  "invoice.paid": pricedAmounts(
    {
      ...invoiceFields,
      hosted_invoice_url: url.nullable(),
      paid_at: iso.nullable(),
      payment_id: z.string().max(64).nullable(),
      /** What settled to the merchant (payments receipt context); null when payments has no receipt. */
      settled_display: z.string().max(200).nullable(),
      evidence_links: z.array(url).max(10),
    },
    INVOICE_AMOUNTS,
  ),
  /** No link: a void invoice cannot be paid (billing returns no hosted link for it). */
  "invoice.voided": pricedAmounts({ ...invoiceFields, voided_at: iso.nullable() }, INVOICE_AMOUNTS),
  "subscription.renewal_upcoming": pricedAmounts(
    {
      subscription_id: text(64),
      merchant_name: text(200),
      customer_name: z.string().max(200).nullable(),
      livemode: z.boolean(),
      trialing: z.boolean(),
      renews_at: iso,
      interval: z.enum(["day", "week", "month", "year"]),
      interval_count: z.int().min(1).max(12),
      next_amount: pricingAmount,
      items: z.array(z.object({ description: text(500), quantity: z.int().min(1) })).max(20),
      /** Stage 4: the subscription collects renewals from a vault mandate (else each invoice is paid by hand). */
      auto_debit: z.boolean().default(false),
    },
    ["next_amount"],
  ),
  // stage 4 — mandate mails to the payer (lld/notify.md §4, spec 0.4.0); recipient: the customer
  "mandate.activated": z.object({ ...mandateFields, cancel_call: nearCall }),
  "mandate.insufficient_funds": z.object({ ...mandateFields, invoice_id: z.string().max(64).nullable() }),
  "mandate.canceled": z.object({ ...mandateFields, refunded: baseUnits }),
  "mandate.unlinked": z.object({
    ...mandateFields,
    cancel_call: nearCall,
    unlinked_reason: z.string().max(64).nullable(),
  }),
  "mandate.released": z.object({ ...mandateFields, cancel_call: nearCall }),
} as const;

export type TemplateName = keyof typeof SCHEMAS;
export type Variables<T extends TemplateName> = z.output<(typeof SCHEMAS)[T]>;
export const TEMPLATE_NAMES = Object.keys(SCHEMAS) as TemplateName[];

export class VariablesError extends Error {
  constructor(
    readonly template: string,
    readonly issues: string[],
  ) {
    super(`invalid variables for ${template}: ${issues.join("; ")}`);
    this.name = "VariablesError";
  }
}

export function isTemplate(name: string): name is TemplateName {
  return Object.hasOwn(SCHEMAS, name);
}

/** Validates (and normalizes) the variables of a template. */
export function parseVariables<T extends TemplateName>(template: T, variables: unknown): Variables<T> {
  const r = (SCHEMAS[template] as z.ZodType).safeParse(variables);
  if (!r.success)
    throw new VariablesError(
      template,
      r.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`),
    );
  return r.data as Variables<T>;
}

// ---------------------------------------------------------------------------------------------
// English copy
// ---------------------------------------------------------------------------------------------

const IGNORE = "If you did not expect this email, you can ignore it.";
const NOT_YOU =
  "If you or a teammate did not make this change, sign in now, disable the destination and contact NearPay support.";

function destinationFacts(v: z.output<typeof destination>): Block[] {
  return [
    {
      kind: "facts",
      rows: [...(v.label ? ([["Label", v.label]] as const) : []), ["Chain", v.chain_name], ["Asset", v.asset_id]],
    },
    { kind: "code", label: "Address", text: v.address },
    { kind: "code", label: "Fingerprint (compare with the one shown in the dashboard)", text: v.fingerprint },
  ];
}

const formatDate = (s: string) => `${new Date(s).toISOString().replace("T", " ").slice(0, 16)} UTC`;

/** Receipt amount: fiat minor units with the currency's exponent; asset pricing shows the settled value. */
export function formatPrice(amount: number | string, currency: string, settledDisplay: string): string {
  if (currency === "asset") return settledDisplay;
  const digits = minorUnits(currency);
  return `${formatUnits(BigInt(amount), digits, digits)} ${currency.toUpperCase()}`;
}

/**
 * Billing amount (INV-5: integers only): fiat minor units with the currency's exponent, asset base
 * units with the asset's decimals and symbol (at least 2 fraction digits when the asset has them).
 */
export function formatAmount(
  amount: number | string,
  currency: string,
  asset: { readonly symbol: string; readonly decimals: number } | null,
): string {
  if (currency === "asset") {
    if (!asset) throw new RangeError("asset amount without the asset's display data");
    return `${formatUnits(BigInt(amount), asset.decimals, Math.min(2, asset.decimals))} ${asset.symbol}`;
  }
  const digits = minorUnits(currency);
  return `${formatUnits(BigInt(amount), digits, digits)} ${currency.toUpperCase()}`;
}

/** `month`, 1 → `Monthly`; `week`, 2 → `Every 2 weeks`. */
export function formatInterval(interval: "day" | "week" | "month" | "year", count: number): string {
  if (count === 1) return { day: "Daily", week: "Weekly", month: "Monthly", year: "Yearly" }[interval];
  return `Every ${count} ${interval}s`;
}

/** UTC calendar day, e.g. `14 Nov 2026`. */
export function formatDay(s: string): string {
  const d = new Date(s);
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${d.getUTCDate()} ${months[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

/** `15` → `15 minutes`, `1440` → `24 hours`, `10080` → `7 days`. */
export function formatDuration(minutes: number): string {
  const unit = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;
  if (minutes % 1440 === 0 && minutes > 1440) return unit(minutes / 1440, "day");
  if (minutes % 60 === 0) return unit(minutes / 60, "hour");
  return unit(minutes, "minute");
}

const ROLE_LABELS: Record<(typeof ROLES)[number], string> = {
  owner: "Owner",
  admin: "Admin",
  developer: "Developer",
  finance: "Finance",
  support: "Support",
  viewer: "Viewer",
};
const OPS_ROLE_LABELS: Record<(typeof OPS_ROLES)[number], string> = { ops: "Operator", ops_admin: "Ops admin" };

const APPROVAL_ACTIONS: Record<string, string> = {
  "account.suspend": "Suspend account",
  "account.reinstate": "Reinstate account",
  "kill_switch.release": "Release the kill switch",
};

const TEST_MODE = "Test mode — no real funds moved.";

const SUBJECT_TYPES: Record<string, string> = {
  execution: "payment",
  payment_intent: "payment",
  agent_payment: "agent payment",
  settlement_destination: "settlement destination",
};

type InvoiceVars = Variables<"invoice.issued"> | Variables<"invoice.reminder"> | Variables<"invoice.paid">;

/**
 * Invoice lines and the total, as a facts table (`Description × 3` → amount). The context lists at
 * most 20 lines and no subtotal: with fewer than 20 lines every line is present, so `total − Σ lines`
 * is the exclusive tax (inclusive tax is already inside the line amounts) and is shown as "Tax";
 * with 20 lines the rest is left to the invoice page.
 */
function invoiceLines(v: InvoiceVars | Variables<"invoice.voided">): Block {
  const money = (a: number | string | bigint) => formatAmount(a.toString(), v.currency, v.asset);
  const sum = v.lines.reduce((n, l) => n + BigInt(l.amount), 0n);
  const rest = BigInt(v.total) - sum;
  const complete = v.lines.length < 20;
  return {
    kind: "facts",
    rows: [
      ...v.lines.map(
        (l) => [l.quantity > 1 ? `${l.description} × ${l.quantity}` : l.description, money(l.amount)] as const,
      ),
      ...(rest > 0n
        ? [complete ? (["Tax", money(rest)] as const) : (["More lines and tax", "On the invoice page"] as const)]
        : []),
      ["Total", money(v.total)],
    ],
  };
}

const billingPeriod = (v: { period_start: string | null; period_end: string | null }) =>
  v.period_start && v.period_end
    ? ([
        [
          "Billing period",
          `${formatDay(v.period_start)} – ${formatDay(new Date(Date.parse(v.period_end) - 1).toISOString())}`,
        ],
      ] as const)
    : [];

const testBanner = (livemode: boolean): Block[] =>
  livemode
    ? []
    : [
        {
          kind: "callout",
          tone: "warning",
          text: "Test mode — no real funds move and this invoice cannot be paid with real money.",
        },
      ];

const testTag = (livemode: boolean) => (livemode ? "" : " [test]");

const HOSTED_LINK_NOTE =
  "This link is personal: anyone who has it can see this invoice, so do not forward it. The invoice page shows the merchant's name; check it before you pay.";

const merchantNote = (merchant: string) =>
  `NearPay processes payments for ${merchant}; payments settle directly to the merchant and NearPay never holds the funds. Contact ${merchant} with questions about this invoice.`;

const greeting = (name: string | null): Block[] => (name ? [{ kind: "p", text: `Hello ${name},` }] : []);

/** When a reminder falls relative to the due date, from its offset (pure: no clock). */
function reminderCopy(v: Variables<"invoice.reminder">) {
  const due = v.due_date ? formatDay(v.due_date) : null;
  const d = v.reminder.offset_days;
  const days = (n: number) => `${n} day${n === 1 ? "" : "s"}`;
  if (d < 0)
    return {
      subject: `Reminder: invoice ${v.number} from ${v.merchant_name} is due in ${days(-d)}`,
      heading: "Payment reminder",
      text: `This is a reminder that invoice ${v.number} from ${v.merchant_name} is due in ${days(-d)}${due ? `, on ${due}` : ""}.`,
    };
  if (d === 0)
    return {
      subject: `Invoice ${v.number} from ${v.merchant_name} is due today`,
      heading: "Invoice due today",
      text: `Invoice ${v.number} from ${v.merchant_name} is due today.`,
    };
  return {
    subject: `Overdue: invoice ${v.number} from ${v.merchant_name}`,
    heading: "Invoice overdue",
    text: `Invoice ${v.number} from ${v.merchant_name} was due ${days(d)} ago${due ? `, on ${due}` : ""}, and is still unpaid.`,
  };
}

type MandateVars =
  | Variables<"mandate.activated">
  | Variables<"mandate.insufficient_funds">
  | Variables<"mandate.canceled">
  | Variables<"mandate.unlinked">
  | Variables<"mandate.released">;

/** Token base units with the mandate token's symbol and decimals (INV-5). */
const tokenAmount = (a: string, v: { token: { symbol: string; decimals: number } }) =>
  formatAmount(a, "asset", v.token);

/** `100 USDC per month`; without the subscription's period, `per period`. */
function perPeriod(v: MandateVars): string {
  const a = tokenAmount(v.amount_per_period, v);
  if (!v.interval || !v.interval_count) return `${a} per period`;
  return v.interval_count === 1 ? `${a} per ${v.interval}` : `${a} every ${v.interval_count} ${v.interval}s`;
}

/** NEAR account for display: implicit (64-hex) accounts are shortened, named ones kept whole. */
export function shortAccount(a: string): string {
  return a.length > 32 ? `${a.slice(0, 8)}…${a.slice(-8)}` : a;
}

/** `100 Tgas`; deposits under 0.000001 NEAR in yoctoNEAR, else in NEAR. */
export function formatGas(gas: string): string {
  return `${formatUnits(BigInt(gas), 12, 0)} Tgas`;
}
export function formatDeposit(yocto: string): string {
  const y = BigInt(yocto);
  return y < 10n ** 18n ? `${y} yoctoNEAR` : `${formatUnits(y, 24, 0)} NEAR`;
}

const UNLINKED_REASONS: Record<string, string> = {
  subscription_not_auto_debit: "the subscription does not use auto-debit",
  subscription_ended: "the subscription has ended",
  already_linked: "another mandate already pays this subscription",
  receiver_kind_mismatch: "its receiving account is not the merchant's",
  receiver_not_destination: "its receiving account is not the merchant's",
  token_mismatch: "its token differs from the subscription's",
  amount_mismatch: "its amount per period differs from the subscription's price",
  period_mismatch: "its period differs from the subscription's billing period",
  fee_mismatch: "its fee differs from the agreed terms",
  start_too_late: "it starts after the current billing period ends",
  max_periods_too_low: "it covers fewer periods than the subscription needs",
  mode_mismatch: "it was created in the other mode (test or live) than the subscription",
};
const unlinkedReason = (r: string | null) =>
  (r ? UNLINKED_REASONS[r] : undefined) ?? "its terms do not match the subscription's";

/** Amount, balance and identifiers of a mandate (`withNext`: the next collection time). */
function mandateFacts(v: MandateVars, withNext: boolean): Block {
  const covered = BigInt(v.amount_per_period) > 0n ? BigInt(v.balance) / BigInt(v.amount_per_period) : 0n;
  return {
    kind: "facts",
    rows: [
      ["Amount", perPeriod(v)],
      ["Balance", `${tokenAmount(v.balance, v)} (covers ${covered} period${covered === 1n ? "" : "s"})`],
      ...(withNext && v.next_collect_at ? ([["Next collection", formatDate(v.next_collect_at)]] as const) : []),
      ["Your NEAR account", shortAccount(v.payer)],
      ["Mandate", v.mandate_id],
      ["Vault", v.vault_contract],
      ["Vault mandate id", String(v.onchain_id)],
    ],
  };
}

/** A payer transaction spelled out so it can be sent from any NEAR wallet (FR-BIL-04). */
function callBlocks(c: NonNullable<MandateVars["cancel_call"]>, payer: string, label: string): Block[] {
  return [
    { kind: "p", text: `${label}, signed by your NEAR account ${shortAccount(payer)}:` },
    {
      kind: "facts",
      rows: [
        ["Contract", c.contract],
        ["Method", c.method],
        ["Deposit", formatDeposit(c.deposit_yocto)],
        ["Gas", formatGas(c.gas)],
      ],
    },
    { kind: "code", label: "Arguments", text: c.args_json },
  ];
}

const mandateBanner = (livemode: boolean): Block[] =>
  livemode
    ? []
    : [
        {
          kind: "callout",
          tone: "warning",
          text: "Test mode — this mandate is in the sandbox vault stand-in; no real funds moved.",
        },
      ];

/** INV-1 line every mandate mail carries, and the link warning when a hosted link is shown. */
function mandateNotes(v: { merchant_name: string; manage_url: string | null }): Block[] {
  return [
    ...(v.manage_url
      ? [
          {
            kind: "note",
            text: "The subscription page link is personal: anyone who has it can see your invoice, so do not forward it.",
          } as const,
        ]
      : []),
    {
      kind: "note",
      text: `NearPay never holds these funds and cannot move them: they stay in the vault contract under your NEAR account, which only collects what you authorised for ${v.merchant_name}. Only you (or ${v.merchant_name}'s receiving account) can cancel. Contact ${v.merchant_name} with questions about your subscription.`,
    },
  ];
}

const en: { [T in TemplateName]: (v: Variables<T>) => Content } = {
  "auth.magic_link": (v) => {
    const copy = {
      signup: {
        subject: "Confirm your email to finish signing up",
        heading: "Confirm your email",
        action: "Confirm email",
      },
      recovery: { subject: "Your NearPay sign-in link", heading: "Sign in to NearPay", action: "Sign in" },
      invite: {
        subject: "You have been invited to NearPay",
        heading: "Join your team on NearPay",
        action: "Accept invitation",
      },
    }[v.purpose];
    return {
      subject: copy.subject,
      preheader: `This link works once and expires in ${v.expires_in_minutes} minutes.`,
      heading: copy.heading,
      blocks: [
        { kind: "p", text: `Use the button below within ${v.expires_in_minutes} minutes. The link works once.` },
        { kind: "button", label: copy.action, href: v.link_url },
        { kind: "note", text: `Never share this link: it signs you in. ${IGNORE}` },
      ],
    };
  },
  "account.welcome": (v) => ({
    subject: "Welcome to NearPay",
    preheader: "Your account is ready in test mode.",
    heading: `Welcome, ${v.account_name}`,
    blocks: [
      {
        kind: "p",
        text: "Your account is ready in test mode: create a test payment, add a settlement destination and an API key from the dashboard.",
      },
      {
        kind: "p",
        text: "Live payments open once you add your business details and NearPay reviews them.",
      },
      { kind: "button", label: "Open the dashboard", href: v.dashboard_url },
    ],
  }),
  "security.destination_pending": (v) => ({
    subject: "Security alert: a new settlement destination was added",
    preheader: "Check the address and fingerprint now.",
    heading: "New settlement destination",
    blocks: [
      {
        kind: "p",
        text: v.active_now
          ? "A settlement destination was added to your account. It is active now: new payments can settle to it."
          : v.active_at
            ? `A settlement destination was added to your account. It is active from ${formatDate(v.active_at)} unless it is disabled first.`
            : "A settlement destination was added to your account and is in its cool-off period.",
      },
      ...destinationFacts(v),
      { kind: "p", text: NOT_YOU },
      { kind: "button", label: "Review destinations", href: v.dashboard_url },
    ],
  }),
  "security.destination_activated": (v) => ({
    subject: "Security alert: a settlement destination is now active",
    preheader: "New payments can settle to this address.",
    heading: "Settlement destination active",
    blocks: [
      { kind: "p", text: "This settlement destination is now active: new payments can settle to it." },
      ...destinationFacts(v),
      { kind: "p", text: NOT_YOU },
      { kind: "button", label: "Review destinations", href: v.dashboard_url },
    ],
  }),
  "security.destination_disabled": (v) => ({
    subject: "Security alert: a settlement destination was disabled",
    preheader: "New payments no longer settle to this address.",
    heading: "Settlement destination disabled",
    blocks: [
      {
        kind: "p",
        text: `This settlement destination was disabled${v.disabled_reason ? ` (${v.disabled_reason.replaceAll("_", " ")})` : ""}. New payments no longer settle to it.`,
      },
      ...destinationFacts(v),
      { kind: "button", label: "Review destinations", href: v.dashboard_url },
    ],
  }),
  "security.destination_blocked": (v) => ({
    subject: "A settlement destination was blocked",
    preheader: "It did not pass compliance screening.",
    heading: "Settlement destination blocked",
    blocks: [
      {
        kind: "p",
        text: "One of your settlement destinations did not pass compliance screening and was blocked. New payments no longer settle to it; add another destination to keep receiving payments.",
      },
      { kind: "code", label: "Destination", text: v.destination_id },
      { kind: "button", label: "Review destinations", href: v.dashboard_url },
      { kind: "note", text: "Contact NearPay support if you believe this is a mistake." },
    ],
  }),
  "kyb.decision": (v) => {
    switch (v.status) {
      case "approved":
        return {
          subject: "You're live on NearPay",
          preheader: "You can accept real payments.",
          heading: "You're live — you can accept real payments",
          blocks: [
            {
              kind: "p",
              text: "Your business details are saved, so live mode is on for your account. Live payments settle to your active live settlement destination — add one in the dashboard if you haven't yet.",
            },
            {
              kind: "p",
              text: "Checkout shows the legal name you declared.",
            },
            { kind: "button", label: "Open the dashboard", href: v.dashboard_url },
          ],
        };
      case "rejected":
        return {
          subject: "Live payments are not available for your business",
          preheader: "Live payments are not available for this account.",
          heading: "Live payments not available",
          blocks: [
            {
              kind: "p",
              text: "NearPay can't offer live payments to this business, so live mode is off for this account. Test mode keeps working.",
            },
            { kind: "note", text: "Contact NearPay support if you have questions." },
          ],
        };
      case "needs_info":
        return {
          subject: "We need more information about your business",
          preheader: "Live mode waits until you update your details.",
          heading: "More information needed",
          blocks: [
            { kind: "p", text: "Before live payments can start, NearPay needs the following:" },
            { kind: "callout", tone: "info", text: v.requested_info ?? "See the dashboard for what is missing." },
            { kind: "p", text: "Update your business details in the dashboard and submit them again." },
            { kind: "button", label: "Update business details", href: v.dashboard_url },
          ],
        };
    }
  },
  "account.suspended": (v) => ({
    subject: "Your NearPay account is suspended",
    preheader: "New payments are paused.",
    heading: "Account suspended",
    blocks: [
      {
        kind: "p",
        text: "Your account is suspended: live-mode changes and new live payments are paused; test mode keeps working. Payments that already settled are not affected (NearPay never holds your funds).",
      },
      { kind: "p", text: "Contact NearPay support to resolve this." },
      { kind: "button", label: "Open the dashboard", href: v.dashboard_url },
    ],
  }),
  "account.reinstated": (v) => ({
    subject: "Your NearPay account is active again",
    preheader: "Payments are open again.",
    heading: "Account reinstated",
    blocks: [
      { kind: "p", text: "Your account is active again; you can accept live payments." },
      { kind: "button", label: "Open the dashboard", href: v.dashboard_url },
    ],
  }),
  "review.opened": (v) => {
    const what = SUBJECT_TYPES[v.subject_type] ?? v.subject_type.replaceAll("_", " ");
    return {
      subject: `A ${what} is under compliance review${v.livemode ? "" : " (test mode)"}`,
      preheader: "No action is needed from you right now.",
      heading: "Compliance review opened",
      blocks: [
        {
          kind: "p",
          text: `A ${what} on your account is under compliance review. Settled funds stay where they are; we may contact you for details.`,
        },
        { kind: "code", label: "Reference", text: v.subject_id },
        { kind: "button", label: "Open the dashboard", href: v.dashboard_url },
      ],
    };
  },
  "review.closed": (v) => {
    const what = SUBJECT_TYPES[v.subject_type] ?? v.subject_type.replaceAll("_", " ");
    return {
      subject: `Compliance review closed${v.livemode ? "" : " (test mode)"}`,
      preheader: `The review of a ${what} is closed.`,
      heading: "Compliance review closed",
      blocks: [
        { kind: "p", text: `The compliance review of a ${what} on your account is closed.` },
        { kind: "code", label: "Reference", text: v.subject_id },
        { kind: "button", label: "Open the dashboard", href: v.dashboard_url },
      ],
    };
  },
  "payment.receipt": (v) => {
    const price = formatPrice(v.amount, v.currency, v.settled_display);
    return {
      subject: `Your receipt from ${v.merchant_name}${v.livemode ? "" : " [test]"}`,
      preheader: `${price} paid to ${v.merchant_name}.`,
      heading: `Receipt from ${v.merchant_name}`,
      blocks: [
        ...(v.livemode ? [] : [{ kind: "callout", tone: "warning", text: TEST_MODE } as const]),
        {
          kind: "facts",
          rows: [
            ["Amount", price],
            ["Settled", v.settled_display],
            ...(v.destination_fingerprint ? ([["Paid to (fingerprint)", v.destination_fingerprint]] as const) : []),
            ["Payment", v.payment_id],
          ],
        },
        ...(v.evidence_links.length
          ? [{ kind: "links", label: "On-chain proof of settlement:", hrefs: v.evidence_links } as const]
          : []),
        {
          kind: "note",
          text: `NearPay processed this payment for ${v.merchant_name}. Contact the merchant about the purchase itself.`,
        },
      ],
    };
  },
  "ops.kill_switch": (v) => ({
    subject: v.engaged ? "[NearPay ops] Kill switch ENGAGED" : "[NearPay ops] Kill switch released",
    preheader: v.reason,
    heading: v.engaged ? "Kill switch engaged: live quoting is stopped" : "Kill switch released: live quoting resumed",
    blocks: [
      {
        kind: "facts",
        rows: [
          ["Reason", v.reason],
          ["Actor", v.actor],
        ],
      },
    ],
  }),
  "ops.audit_finding": (v) => ({
    subject: `[NearPay ops] Audit finding: ${v.result} (${v.check_kind})`,
    preheader: `Execution ${v.execution_id}`,
    heading: "Sentinel audit finding (live)",
    blocks: [
      {
        kind: "facts",
        rows: [
          ["Result", v.result],
          ["Check", v.check_kind],
          ["Finding", v.finding_id],
          ["Execution", v.execution_id],
          ["Account", v.account_id],
        ],
      },
      { kind: "p", text: "A critical compliance case was opened; investigate it in the ops CLI (cases)." },
    ],
  }),
  "webhooks.endpoint_disabled": (v) => ({
    subject: "A webhook endpoint was disabled",
    preheader: "It failed for 72 hours; events are no longer sent to it.",
    heading: "Webhook endpoint disabled",
    blocks: [
      {
        kind: "p",
        text: `This endpoint failed every delivery since ${formatDate(v.failing_since)}, so it was disabled and no longer receives events. Fix it and enable it again in the dashboard; missed events can be replayed.`,
      },
      { kind: "code", label: "Endpoint", text: v.url },
      { kind: "facts", rows: [["Endpoint id", v.endpoint_id]] },
      { kind: "button", label: "Open webhooks", href: v.dashboard_url },
    ],
  }),
  "refund.receipt": (v) => {
    const returned = v.received_display ?? v.refunded_display;
    const original =
      v.original_currency === "asset" ? null : formatPrice(v.original_amount, v.original_currency, v.refunded_display);
    return {
      subject: `Refund from ${v.merchant_name}${v.livemode ? "" : " [test]"}`,
      preheader: `${returned} returned to your wallet by ${v.merchant_name}.`,
      heading: `Refund from ${v.merchant_name}`,
      blocks: [
        ...(v.livemode ? [] : [{ kind: "callout", tone: "warning", text: TEST_MODE } as const]),
        {
          kind: "p",
          text: `${v.merchant_name} refunded your payment. The funds reached your wallet and the transfer is confirmed on-chain.`,
        },
        {
          kind: "facts",
          rows: [
            ["Amount returned", returned],
            ...(v.received_display && v.received_display !== v.refunded_display
              ? ([["Sent by the merchant", v.refunded_display]] as const)
              : []),
            ["Returned to", v.recipient_display],
            ...(original ? ([["Original payment", original]] as const) : []),
            ["Payment", v.payment_id],
            ["Refund", v.refund_id],
          ],
        },
        ...(v.evidence_links.length
          ? [{ kind: "links", label: "On-chain proof of the refund:", hrefs: v.evidence_links } as const]
          : []),
        {
          kind: "note",
          text: `${v.merchant_name} sent this refund from their own wallet; NearPay prepared it and never held the funds. Contact the merchant about the purchase itself.`,
        },
      ],
    };
  },
  "security.member_changed": (v) => {
    const member = v.member_email ?? `A team member (${v.member_id})`;
    const actor = v.actor_email ?? v.actor_id;
    const role = ROLE_LABELS[v.role];
    const copy = {
      added: {
        subject: "Security alert: a team member was added",
        heading: "Team member added",
        text: `${member} now has access to your NearPay account as ${role}.${actor ? "" : " They accepted an invitation sent from your account."}`,
      },
      removed: {
        subject: "Security alert: a team member was removed",
        heading: "Team member removed",
        text: `${member} no longer has access to your NearPay account.`,
      },
      role_changed: {
        subject: "Security alert: a team member's role changed",
        heading: "Team member role changed",
        text: `${member} now has the ${role} role${v.previous_role ? ` (was ${ROLE_LABELS[v.previous_role]})` : ""}.`,
      },
    }[v.change];
    return {
      subject: copy.subject,
      preheader: "Check that you expected this change.",
      heading: copy.heading,
      blocks: [
        { kind: "p", text: copy.text },
        {
          kind: "facts",
          rows: [
            ["Member", v.member_email ?? v.member_id],
            ["Role", role],
            ...(v.change === "role_changed" && v.previous_role
              ? ([["Previous role", ROLE_LABELS[v.previous_role]]] as const)
              : []),
            ...(actor ? ([["Changed by", actor]] as const) : []),
          ],
        },
        {
          kind: "p",
          text: "If you did not expect this change, sign in now, review your team and contact NearPay support.",
        },
        { kind: "button", label: "Review your team", href: v.dashboard_url },
      ],
    };
  },
  "team.invitation": (v) => {
    const validity = formatDuration(v.expires_in_minutes);
    return {
      subject: `You're invited to join ${v.account_display_name} on NearPay`,
      preheader: `The invitation works once and expires in ${validity}.`,
      heading: `Join ${v.account_display_name} on NearPay`,
      blocks: [
        {
          kind: "p",
          text: `You've been invited to join ${v.account_display_name} on NearPay with the ${ROLE_LABELS[v.role]} role.`,
        },
        { kind: "p", text: `Use the button below within ${validity}. The link works once.` },
        { kind: "button", label: "Accept invitation", href: v.link_url },
        {
          kind: "note",
          text: `Accept only if you expected this invitation. Never share this link: it adds you to the account. ${IGNORE}`,
        },
      ],
    };
  },
  "ops.enrolment": (v) => {
    const validity = formatDuration(v.expires_in_minutes);
    return {
      subject: "[NearPay ops] Set up your console access",
      preheader: `The link works once and expires in ${validity}.`,
      heading: "Set up NearPay console access",
      blocks: [
        {
          kind: "p",
          text: `You were added to the NearPay console as ${OPS_ROLE_LABELS[v.role]}. Use the button below within ${validity} to register your hardware security key. The link works once.`,
        },
        { kind: "button", label: "Register security key", href: v.link_url },
        {
          kind: "note",
          text: "The console accepts hardware security keys only. Never share this link. If you did not expect this email, tell the NearPay security team.",
        },
      ],
    };
  },
  "security.destination_approval": (v) => ({
    subject: "Action needed: approve a new settlement destination",
    preheader: "A second owner or admin must approve it. Check the address and fingerprint first.",
    heading: "Settlement destination awaiting approval",
    blocks: [
      {
        kind: "p",
        text: `A teammate added a settlement destination to your account. It needs ${v.approvals_required === 1 ? "1 approval" : `${v.approvals_required} approvals`} from different owners or admins (${v.approvals_received} so far) before it can become active. No payments settle to it until then, and a short security hold may apply after approval.`,
      },
      ...destinationFacts(v),
      {
        kind: "p",
        text: "Before you approve, confirm the address and fingerprint with the teammate who added it, outside email. If you do not recognise it, reject it in the dashboard.",
      },
      { kind: "button", label: "Review destination", href: v.dashboard_url },
    ],
  }),
  "kyb.submitted": (v) => ({
    subject: "We received your business details",
    preheader: "We'll email you as soon as live mode is on.",
    heading: "Business details received",
    blocks: [
      {
        kind: "p",
        text: `Your business details were submitted on ${formatDate(v.submitted_at)}. We'll email you as soon as live mode is on.`,
      },
      {
        kind: "p",
        text: "Test mode keeps working meanwhile. Live payments also need an active settlement destination.",
      },
      { kind: "button", label: "Open the dashboard", href: v.dashboard_url },
    ],
  }),
  "ops.approval_requested": (v) => {
    const label = APPROVAL_ACTIONS[v.action] ?? v.action;
    return {
      subject: `[NearPay ops] Approval needed: ${label}${v.target_type === "account" ? ` ${v.target_id}` : ""}`,
      preheader: `A second ops_admin must approve before ${formatDate(v.expires_at)}.`,
      heading: "Second approval needed",
      blocks: [
        {
          kind: "p",
          text: `An operator requested this action. Nothing changes until an ops_admin other than the requester approves it in the console. The request expires on ${formatDate(v.expires_at)}.`,
        },
        {
          kind: "facts",
          rows: [
            ["Action", label],
            ["Target", v.target_id],
            ["Reason", v.reason],
            ["Requested by", `${v.requested_by} (${OPS_ROLE_LABELS[v.requested_by_role]})`],
            ["Requested", formatDate(v.requested_at)],
            ["Request", v.approval_id],
          ],
        },
        { kind: "button", label: "Open the console", href: v.console_url },
        { kind: "note", text: "Check the reason with the requester before you approve. Rejecting executes nothing." },
      ],
    };
  },
  "security.recovery": (v) => {
    const who = v.user_email ?? `A team member (${v.user_id})`;
    return {
      subject: "Security alert: account access was recovered",
      preheader: `Settlement destination and team changes are locked until ${formatDate(v.lock_until)}.`,
      heading: "Account access recovered",
      blocks: [
        {
          kind: "p",
          text: `${who} regained access to NearPay by email recovery and registered a new passkey on ${formatDate(v.recovered_at)}.`,
        },
        {
          kind: "p",
          text: `As a precaution, settlement destinations cannot be added or approved, and owners and admins cannot be invited, changed or removed, until ${formatDate(v.lock_until)}.`,
        },
        {
          kind: "facts",
          rows: [
            ["User", v.user_email ?? v.user_id],
            ["Recovered", formatDate(v.recovered_at)],
            ["Locked until", formatDate(v.lock_until)],
          ],
        },
        {
          kind: "p",
          text: "If this was not expected, sign in now, review your team and settlement destinations, and contact NearPay support.",
        },
        { kind: "button", label: "Review your account", href: v.dashboard_url },
      ],
    };
  },
  "webhooks.secret_rotated": (v) => {
    const actor = v.actor_email ?? v.actor_id;
    return {
      subject: `Webhook signing secret rotated${v.livemode ? "" : " [test]"}`,
      preheader: v.previous_secret_expires_at
        ? `The previous secret keeps signing until ${formatDate(v.previous_secret_expires_at)}.`
        : "The previous secret no longer signs deliveries.",
      heading: "Webhook signing secret rotated",
      blocks: [
        ...(v.livemode ? [] : [{ kind: "callout", tone: "warning", text: TEST_MODE } as const]),
        {
          kind: "p",
          text: v.previous_secret_expires_at
            ? `The signing secret of this endpoint was rotated. Until ${formatDate(v.previous_secret_expires_at)} each delivery carries signatures with both the new and the previous secret; after that only the new secret signs. Update your endpoint's secret before then.`
            : "The signing secret of this endpoint was rotated and the previous secret was dropped at once: deliveries are signed with the new secret only.",
        },
        { kind: "code", label: "Endpoint", text: v.url },
        {
          kind: "facts",
          rows: [["Endpoint id", v.endpoint_id], ...(actor ? ([["Rotated by", actor]] as const) : [])],
        },
        {
          kind: "p",
          text: "If you did not expect this, sign in now, rotate the secret again and review who has access.",
        },
        { kind: "button", label: "Open webhooks", href: v.dashboard_url },
      ],
    };
  },
  "invoice.issued": (v) => {
    const due = formatAmount(v.amount_remaining, v.currency, v.asset);
    return {
      subject: `Invoice ${v.number} from ${v.merchant_name}${testTag(v.livemode)}`,
      preheader: v.due_date ? `${due} due by ${formatDay(v.due_date)}.` : `${due} due.`,
      heading: `Invoice from ${v.merchant_name}`,
      blocks: [
        ...testBanner(v.livemode),
        ...greeting(v.customer_name),
        {
          kind: "p",
          text: `${v.merchant_name} sent you invoice ${v.number}. You can review it and pay with crypto on the secure invoice page.`,
        },
        {
          kind: "facts",
          rows: [
            ["Amount due", due],
            ...(v.due_date ? ([["Due", formatDay(v.due_date)]] as const) : []),
            ["Invoice number", v.number],
            ...billingPeriod(v),
          ],
        },
        invoiceLines(v),
        { kind: "button", label: "View and pay invoice", href: v.hosted_invoice_url },
        { kind: "note", text: HOSTED_LINK_NOTE },
        { kind: "note", text: merchantNote(v.merchant_name) },
      ],
    };
  },
  "invoice.reminder": (v) => {
    const copy = reminderCopy(v);
    const remaining = formatAmount(v.amount_remaining, v.currency, v.asset);
    return {
      subject: `${copy.subject}${testTag(v.livemode)}`,
      preheader: `${remaining} still to pay.`,
      heading: copy.heading,
      blocks: [
        ...testBanner(v.livemode),
        ...greeting(v.customer_name),
        { kind: "p", text: copy.text },
        {
          kind: "facts",
          rows: [
            ["Amount due", remaining],
            ...(v.due_date ? ([["Due", formatDay(v.due_date)]] as const) : []),
            ["Invoice number", v.number],
            ...billingPeriod(v),
          ],
        },
        ...(v.reminder.last
          ? [
              {
                kind: "callout",
                tone: "info",
                text: v.subscription_id
                  ? `This is the last reminder for this invoice. If it stays unpaid, your subscription with ${v.merchant_name} may be canceled or paused.`
                  : "This is the last reminder for this invoice.",
              } as const,
            ]
          : []),
        { kind: "button", label: "Pay invoice", href: v.hosted_invoice_url },
        {
          kind: "note",
          text: "Already paid? You can ignore this reminder: a payment can take a few minutes to confirm on-chain.",
        },
        { kind: "note", text: HOSTED_LINK_NOTE },
        { kind: "note", text: merchantNote(v.merchant_name) },
      ],
    };
  },
  "invoice.paid": (v) => {
    const paid = formatAmount(v.amount_due, v.currency, v.asset);
    return {
      subject: `Payment received: invoice ${v.number} from ${v.merchant_name}${testTag(v.livemode)}`,
      preheader: `${paid} paid to ${v.merchant_name}.`,
      heading: `Invoice ${v.number} paid`,
      blocks: [
        ...(v.livemode ? [] : [{ kind: "callout", tone: "warning", text: TEST_MODE } as const]),
        ...greeting(v.customer_name),
        {
          kind: "p",
          text: `Thank you. Your payment of ${paid} to ${v.merchant_name} for invoice ${v.number} is confirmed on-chain.`,
        },
        {
          kind: "facts",
          rows: [
            ["Amount paid", paid],
            ...(v.settled_display ? ([["Settled", v.settled_display]] as const) : []),
            ["Invoice number", v.number],
            ...(v.paid_at ? ([["Paid", formatDate(v.paid_at)]] as const) : []),
            ...billingPeriod(v),
            ...(v.payment_id ? ([["Payment", v.payment_id]] as const) : []),
          ],
        },
        invoiceLines(v),
        ...(v.evidence_links.length
          ? [{ kind: "links", label: "On-chain proof of settlement:", hrefs: v.evidence_links } as const]
          : []),
        ...(v.hosted_invoice_url
          ? [{ kind: "button", label: "View invoice", href: v.hosted_invoice_url } as const]
          : []),
        { kind: "note", text: merchantNote(v.merchant_name) },
      ],
    };
  },
  "invoice.voided": (v) => ({
    subject: `Invoice ${v.number} from ${v.merchant_name} was voided${testTag(v.livemode)}`,
    preheader: "You do not need to pay it.",
    heading: "Invoice voided",
    blocks: [
      ...(v.livemode ? [] : [{ kind: "callout", tone: "warning", text: TEST_MODE } as const]),
      ...greeting(v.customer_name),
      {
        kind: "p",
        text: `${v.merchant_name} voided invoice ${v.number}. You do not need to pay it, and its payment link no longer works.`,
      },
      {
        kind: "facts",
        rows: [
          ["Invoice number", v.number],
          ["Amount", formatAmount(v.total, v.currency, v.asset)],
          ...(v.voided_at ? ([["Voided", formatDate(v.voided_at)]] as const) : []),
        ],
      },
      {
        kind: "note",
        text: `If you already sent a payment for this invoice, contact ${v.merchant_name}: they can refund it from their own wallet. NearPay never holds the funds.`,
      },
    ],
  }),
  "subscription.renewal_upcoming": (v) => {
    const amount = formatAmount(v.next_amount, v.currency, v.asset);
    const day = formatDay(v.renews_at);
    const period = formatInterval(v.interval, v.interval_count);
    const how = v.auto_debit
      ? `${v.merchant_name} then collects ${amount} from your auto-debit mandate; if the mandate cannot pay, ${v.merchant_name} emails you an invoice to pay on the secure invoice page.`
      : `${v.merchant_name} will then email you an invoice for ${amount}, which you pay on the secure invoice page.`;
    return {
      subject: v.trialing
        ? `Your ${v.merchant_name} trial ends on ${day}${testTag(v.livemode)}`
        : `Your ${v.merchant_name} subscription renews on ${day}${testTag(v.livemode)}`,
      preheader: v.auto_debit
        ? `${amount} will be collected from your auto-debit mandate.`
        : `${v.merchant_name} will send you an invoice for ${amount}.`,
      heading: v.trialing ? "Your trial ends soon" : "Subscription renewal coming up",
      blocks: [
        ...(v.livemode ? [] : [{ kind: "callout", tone: "warning", text: TEST_MODE } as const]),
        ...greeting(v.customer_name),
        {
          kind: "p",
          text: v.trialing
            ? `Your free trial with ${v.merchant_name} ends on ${day} and your subscription then starts. ${how}`
            : `Your subscription with ${v.merchant_name} renews on ${day}. ${how}`,
        },
        {
          kind: "facts",
          rows: [
            ["Next invoice", amount],
            [v.trialing ? "Trial ends" : "Renews", day],
            ["Billing", period],
            ...(v.auto_debit ? ([["Payment", "Auto-debit from your vault mandate"]] as const) : []),
            ...v.items.map((i) => [i.description, `Quantity ${i.quantity}`] as const),
          ],
        },
        {
          kind: "note",
          text: v.auto_debit
            ? `Make sure your mandate's balance covers ${amount} before ${day}. To change or cancel your subscription, contact ${v.merchant_name} before ${day}; you can cancel the mandate yourself at any time.`
            : `Nothing is charged automatically: you pay each invoice yourself. To change or cancel your subscription, contact ${v.merchant_name} before ${day}.`,
        },
      ],
    };
  },
  // stage 4 — mandate mails to the payer
  "mandate.activated": (v) => {
    const per = perPeriod(v);
    return {
      subject: `Auto-debit is set up for your ${v.merchant_name} subscription${testTag(v.livemode)}`,
      preheader: `${per} is collected from your vault balance. You can cancel at any time.`,
      heading: "Auto-debit is active",
      blocks: [
        ...mandateBanner(v.livemode),
        ...greeting(v.customer_name),
        {
          kind: "p",
          text: `Your auto-debit mandate for your subscription with ${v.merchant_name} is active. Each billing period, ${v.merchant_name}'s renewal is collected from the balance you deposited in the NearPay subscription vault, so you no longer pay each invoice by hand.`,
        },
        mandateFacts(v, true),
        {
          kind: "callout",
          tone: "info",
          text: "You can cancel at any time. Cancelling stops all future collections and returns the remaining balance to your NEAR account.",
        },
        ...callBlocks(v.cancel_call, v.payer, "To cancel from any NEAR wallet, send this transaction"),
        ...(v.manage_url ? [{ kind: "button", label: "Manage auto-debit", href: v.manage_url } as const] : []),
        ...mandateNotes(v),
      ],
    };
  },
  "mandate.insufficient_funds": (v) => {
    const per = tokenAmount(v.amount_per_period, v);
    const balance = tokenAmount(v.balance, v);
    return {
      subject: `Top-up needed: auto-debit for ${v.merchant_name}${testTag(v.livemode)}`,
      preheader: `Your mandate holds ${balance}; this period needs ${per}.`,
      heading: "Your auto-debit balance is too low",
      blocks: [
        ...mandateBanner(v.livemode),
        ...greeting(v.customer_name),
        {
          kind: "p",
          text: `${v.merchant_name} could not collect this period's ${per} because your auto-debit mandate holds only ${balance}.`,
        },
        {
          kind: "p",
          text: `${v.merchant_name} emails you this period's invoice${v.invoice_id ? ` (${v.invoice_id})` : ""} to pay on the secure invoice page. To keep auto-debit for later periods, top up your mandate.`,
        },
        mandateFacts(v, false),
        ...(v.manage_url ? [{ kind: "button", label: "Top up or pay", href: v.manage_url } as const] : []),
        ...mandateNotes(v),
      ],
    };
  },
  "mandate.canceled": (v) => {
    const refunded = BigInt(v.refunded) > 0n;
    return {
      subject: `Auto-debit canceled: ${v.merchant_name}${testTag(v.livemode)}`,
      preheader: refunded
        ? `${tokenAmount(v.refunded, v)} was returned to your NEAR account.`
        : "No further periods will be collected.",
      heading: "Auto-debit canceled",
      blocks: [
        ...mandateBanner(v.livemode),
        ...greeting(v.customer_name),
        {
          kind: "p",
          text: `Your auto-debit mandate for your subscription with ${v.merchant_name} is canceled. No further periods will be collected from it.`,
        },
        {
          kind: "facts",
          rows: [
            ...(refunded ? ([["Returned to you", tokenAmount(v.refunded, v)]] as const) : []),
            ["Your NEAR account", shortAccount(v.payer)],
            ["Mandate", v.mandate_id],
            ["Vault mandate id", String(v.onchain_id)],
          ],
        },
        ...(refunded
          ? [
              {
                kind: "p",
                text: `The vault returned ${tokenAmount(v.refunded, v)} to ${shortAccount(v.payer)}.`,
              } as const,
            ]
          : v.withdraw_call
            ? [
                {
                  kind: "callout",
                  tone: "warning",
                  text: `The refund failed, so ${BigInt(v.balance) > 0n ? tokenAmount(v.balance, v) : "your remaining balance"} stays in the vault for you. Withdraw it from the subscription page, or send the withdraw transaction below from your wallet.`,
                } as const,
                ...callBlocks(v.withdraw_call, v.payer, "To withdraw from any NEAR wallet, send this transaction"),
                ...(v.manage_url ? [{ kind: "button", label: "Withdraw", href: v.manage_url } as const] : []),
              ]
            : [{ kind: "p", text: "No balance remained on the mandate." } as const]),
        {
          kind: "note",
          text: `If your subscription continues, ${v.merchant_name} emails you each invoice to pay on the secure invoice page.`,
        },
        ...mandateNotes({ ...v, manage_url: refunded ? null : v.manage_url }),
      ],
    };
  },
  "mandate.unlinked": (v) => ({
    subject: `Action needed: cancel your mandate for ${v.merchant_name} to get your funds back${testTag(v.livemode)}`,
    preheader: "NearPay will not collect from this mandate. Cancel it to get the balance back.",
    heading: "This mandate will not be used",
    blocks: [
      ...mandateBanner(v.livemode),
      ...greeting(v.customer_name),
      {
        kind: "p",
        text: `You funded an auto-debit mandate for your subscription with ${v.merchant_name}, but ${unlinkedReason(v.unlinked_reason)}. NearPay will never collect from it.`,
      },
      {
        kind: "callout",
        tone: "info",
        text: `Cancel the mandate to get your balance of ${tokenAmount(v.balance, v)} back to your NEAR account.`,
      },
      mandateFacts(v, false),
      ...callBlocks(v.cancel_call, v.payer, "To cancel from any NEAR wallet, send this transaction"),
      ...(v.manage_url ? [{ kind: "button", label: "Open the subscription page", href: v.manage_url } as const] : []),
      ...mandateNotes(v),
    ],
  }),
  "mandate.released": (v) => {
    const left = BigInt(v.balance) > 0n;
    return {
      subject: `Auto-debit ended for ${v.merchant_name}: cancel your mandate${left ? " to get your balance back" : ""}${testTag(v.livemode)}`,
      preheader: left
        ? `${tokenAmount(v.balance, v)} is still in the vault for you.`
        : "NearPay will not collect from your mandate any more.",
      heading: "Auto-debit ended",
      blocks: [
        ...mandateBanner(v.livemode),
        ...greeting(v.customer_name),
        {
          kind: "p",
          text: `Your subscription with ${v.merchant_name} has ended or no longer uses auto-debit, so NearPay will not collect from your mandate any more.`,
        },
        {
          kind: "callout",
          tone: "info",
          text: left
            ? `${tokenAmount(v.balance, v)} remains in the vault under your NEAR account. Cancel the mandate to get it back.`
            : "No balance remains on the mandate. You can cancel it to close it.",
        },
        mandateFacts(v, false),
        ...callBlocks(v.cancel_call, v.payer, "To cancel from any NEAR wallet, send this transaction"),
        ...(v.manage_url ? [{ kind: "button", label: "Open the subscription page", href: v.manage_url } as const] : []),
        ...mandateNotes(v),
      ],
    };
  },
};

const COPY: Record<Locale, typeof en> = { en };

/** Renders a template's content in a locale (variables are validated first). */
export function renderContent<T extends TemplateName>(template: T, variables: unknown, locale: Locale = "en"): Content {
  const v = parseVariables(template, variables);
  return (COPY[locale][template] as (v: Variables<T>) => Content)(v);
}

/** Footer line of every mail. */
export const FOOTER: Record<Locale, string> = {
  en: "NearPay · non-custodial payments on NEAR Intents · A transactional message, never marketing.",
};

/**
 * Template catalogue (lld/notify.md §4). Each template validates its variables (zod) and renders
 * localized content blocks. Pure. Variables never carry secrets beyond what the mail must show (a
 * magic link is the one exception: it IS the message); recipients are resolved by the caller.
 *
 * Copy rules: security mails always show the destination fingerprint (security.md T-01); mails to
 * merchants never repeat internal compliance reasons (only a `needs_info` request is shown).
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
const text = (max = 500) => z.string().min(1).max(max);
const iso = z.iso.datetime({ offset: true });

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
  "security.destination_pending": destination.extend({ active_at: iso.nullable() }),
  "security.destination_activated": destination,
  "security.destination_disabled": destination.extend({ disabled_reason: z.string().max(200).nullable() }),
  "security.destination_blocked": z.object({ destination_id: text(64), dashboard_url: url }),
  "kyb.decision": z.object({
    status: z.enum(["approved", "rejected", "needs_info"]),
    reason: z.string().max(500).nullable(),
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
    amount: z.union([z.int().min(0), z.string().regex(/^\d{1,78}$/)]),
    currency: z.string().regex(/^([a-z]{3}|asset)$/),
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

const SUBJECT_TYPES: Record<string, string> = {
  execution: "payment",
  payment_intent: "payment",
  agent_payment: "agent payment",
  settlement_destination: "settlement destination",
};

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
      { kind: "p", text: "Live payments open after business verification (KYB)." },
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
        text: v.active_at
          ? `A settlement destination was added to your account. It becomes usable on ${formatDate(v.active_at)} unless it is disabled first.`
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
          subject: "Your business is verified",
          preheader: "You can now enable live payments.",
          heading: "Business verification approved",
          blocks: [
            {
              kind: "p",
              text: "Your business verification (KYB) was approved. You can now enable live mode in the dashboard.",
            },
            { kind: "button", label: "Open the dashboard", href: v.dashboard_url },
          ],
        };
      case "rejected":
        return {
          subject: "Your business verification was not approved",
          preheader: "Live payments are not available for this account.",
          heading: "Business verification not approved",
          blocks: [
            {
              kind: "p",
              text: "We could not approve your business verification (KYB), so live payments are not available for this account. Test mode keeps working.",
            },
            { kind: "note", text: "Contact NearPay support if you have questions." },
          ],
        };
      case "needs_info":
        return {
          subject: "We need more information to verify your business",
          preheader: "Your verification is paused until you reply.",
          heading: "More information needed",
          blocks: [
            { kind: "p", text: "To continue your business verification (KYB), we need the following:" },
            { kind: "p", text: v.reason ?? "Additional documents (see the dashboard)." },
            { kind: "button", label: "Continue verification", href: v.dashboard_url },
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
        ...(v.livemode ? [] : [{ kind: "note", text: "Test mode: no real funds moved." } as const]),
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

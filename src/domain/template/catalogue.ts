/**
 * Template catalogue (lld/notify.md §4). Each template validates its variables (zod) and renders
 * localized content blocks. Pure. Variables never carry secrets beyond what the mail must show (a
 * magic link is the one exception: it IS the message); recipients are resolved by the caller.
 *
 * Copy rules: security mails always show the destination fingerprint (security.md T-01); mails to
 * merchants never repeat internal compliance reasons (only a `needs_info` request is shown); KYB is
 * self-declared business details reviewed by NearPay ops (ADR-0020 d3), so no mail ever claims a
 * verified business or identity (product/design-system.md §6.3); refund mails say the merchant sent
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
          subject: "Your business details are approved",
          preheader: "You can now turn on live mode.",
          heading: "Business details approved",
          blocks: [
            {
              kind: "p",
              text: "NearPay reviewed and approved the business details you submitted. You can now turn on live mode in the dashboard; it also needs an active settlement destination.",
            },
            {
              kind: "p",
              text: "Checkout shows your approved legal name with the note “Business details reviewed by NearPay”.",
            },
            { kind: "button", label: "Open the dashboard", href: v.dashboard_url },
          ],
        };
      case "rejected":
        return {
          subject: "Your business details were not approved",
          preheader: "Live payments are not available for this account.",
          heading: "Business details not approved",
          blocks: [
            {
              kind: "p",
              text: "NearPay could not approve the business details you submitted, so live payments are not available for this account. Test mode keeps working.",
            },
            { kind: "note", text: "Contact NearPay support if you have questions." },
          ],
        };
      case "needs_info":
        return {
          subject: "We need more information about your business",
          preheader: "The review is paused until you update your details.",
          heading: "More information needed",
          blocks: [
            { kind: "p", text: "To continue reviewing your business details, NearPay needs the following:" },
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
        text: `A teammate added a settlement destination to your account. It needs ${v.approvals_required === 1 ? "1 approval" : `${v.approvals_required} approvals`} from different owners or admins (${v.approvals_received} so far) before its 24-hour cool-off starts. No payments settle to it until then.`,
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
    preheader: "NearPay will review them and email you the outcome.",
    heading: "Business details received",
    blocks: [
      {
        kind: "p",
        text: `Your business details were submitted on ${formatDate(v.submitted_at)}. NearPay will review the details you declared and email you when the review is done.`,
      },
      {
        kind: "p",
        text: "Test mode keeps working while you wait. Live mode becomes available once the review is approved and you have an active settlement destination.",
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

/**
 * Which email an event sends, to whom, with which variables (lld/notify.md §4). Pure.
 *
 * Event payloads carry no PII, so a plan names an *audience*; the worker resolves it to addresses
 * through the owner services (identity notification recipients, payments receipt context) or the
 * configured ops contacts. Every subject the catalogue routes to notify has a plan or an explicit
 * reason to send nothing.
 */
import type { Subject } from "@nearpay-internal/spec";
import type { TemplateName } from "../template/catalogue.js";
import { MANDATE_TEMPLATES } from "./mandate.js";

export type RecipientKind = "security" | "billing" | "developer";
export type Role = "owner" | "admin" | "developer" | "finance" | "support" | "viewer";

export type Audience =
  /** Users of an account (identity `notification-recipients?kind=`), optionally only some roles. */
  | {
      readonly kind: "account";
      readonly accountId: string;
      readonly recipients: RecipientKind;
      readonly roles?: readonly Role[];
      /** Users never mailed (e.g. who already approved a destination). */
      readonly exclude?: readonly string[];
    }
  /**
   * Spec 0.2.1: users of several accounts (e.g. every account a recovered user manages), mailed once
   * each (dedupe by user id across the accounts).
   */
  | {
      readonly kind: "accounts";
      readonly accountIds: readonly string[];
      readonly recipients: RecipientKind;
      readonly roles?: readonly Role[];
    }
  /** The paying customer (payments `receipt-context`), if the session collected an email. */
  | { readonly kind: "customer"; readonly paymentIntentId: string }
  /** The refunded customer (payments refund `receipt-context`), if an email is on record. */
  | { readonly kind: "refund_customer"; readonly refundId: string }
  /** `NP_SECURITY_CONTACTS` (ops). */
  | { readonly kind: "security_contacts" }
  /**
   * Stage 3: the billed customer of an invoice (billing `notification-context`, `?reminder=` for a
   * reminder). The context also carries the hosted link with the invoice secret, never the event.
   */
  | { readonly kind: "invoice_customer"; readonly invoiceId: string; readonly reminder: number | null }
  /** Stage 3: the customer of a subscription (billing subscription `notification-context`). */
  | { readonly kind: "subscription_customer"; readonly subscriptionId: string }
  /**
   * Stage 4: the payer of a vault mandate (billing mandate `notification-context`). The context also
   * carries the payer's cancel/withdraw transactions and the hosted link with the invoice secret.
   * `accountUuid` is the envelope's account: billing's answer must name the same account.
   */
  | {
      readonly kind: "mandate_customer";
      readonly mandateId: string;
      readonly subscriptionId: string;
      readonly accountUuid: string | null;
    };

export interface Plan {
  readonly template: TemplateName;
  readonly audience: Audience;
  readonly variables: Record<string, unknown>;
  readonly accountId: string | null;
  readonly livemode: boolean | null;
  /**
   * Variables filled at fan-out (`variable → user id`): events carry ids only, so the email comes from
   * the recipient list, else from identity `notification-recipients?user=` (spec 0.2.1: any role, and
   * members removed in the last 7 days), else null (the mail shows the id).
   */
  readonly userEmails?: Readonly<Record<string, string | null>>;
}

/** The envelope fields routing reads (structurally an `@nearpay-internal/bus` Envelope). */
export interface RoutedEvent {
  readonly id: string;
  /** Envelope account UUID (null for platform events). */
  readonly account_id?: string | null;
  readonly subject: string;
  readonly livemode: boolean | null;
  /** When the state change committed (envelope `occurred_at`). */
  readonly occurred_at?: string;
  readonly data: { readonly object: unknown };
}

export interface RoutingOptions {
  readonly dashboardOrigin: string;
  /** Console origin (links in ops approval mails). */
  readonly consoleOrigin: string;
  readonly testModeReceipts: boolean;
  readonly chainName: (caip2: string) => string;
  /** Destination fingerprint, or null when it cannot be computed (unknown chain). */
  readonly fingerprint: (caip2: string, address: string, assetId: string) => string | null;
}

/** Subjects notify consumes (must equal the catalogue's routing to notify; contract-tested). */
export const NOTIFY_SUBJECTS = [
  "evt.identity.account.created",
  "evt.identity.settlement_destination.cooling_off",
  "evt.identity.settlement_destination.activated",
  "evt.identity.settlement_destination.disabled",
  "evt.payments.payment_intent.succeeded",
  "evt.compliance.kyb.approved",
  "evt.compliance.kyb.rejected",
  "evt.compliance.kyb.needs_info",
  "evt.compliance.destination.blocked",
  "evt.compliance.account.suspended",
  "evt.compliance.account.reinstated",
  "evt.compliance.review.opened",
  "evt.compliance.review.closed",
  "evt.sentinel.kill_switch.engaged",
  "evt.sentinel.kill_switch.released",
  "evt.sentinel.audit_finding.created",
  "evt.webhooks.endpoint.disabled",
  // stage 2 (step 2.1 contracts, spec 0.2.0)
  "evt.payments.refund.succeeded",
  "evt.identity.member.added",
  "evt.identity.member.removed",
  "evt.identity.member.role_changed",
  "evt.identity.settlement_destination.pending_approval",
  "evt.compliance.kyb.submitted",
  "evt.compliance.account.action_requested",
  "evt.sentinel.kill_switch.release_requested",
  // spec 0.2.1
  "evt.identity.user.recovered",
  "evt.webhooks.endpoint.secret_rotated",
  // stage 3 — billing (spec 0.3.0 `BILLING_EMAIL_TEMPLATES`)
  "evt.billing.invoice.sent",
  "evt.billing.invoice.reminder",
  "evt.billing.invoice.paid",
  "evt.billing.invoice.voided",
  "evt.billing.subscription.renewal_upcoming",
  // stage 4 — mandate mails to the payer (spec 0.4.0 `BILLING_EMAIL_TEMPLATES`)
  "evt.billing.mandate.activated",
  "evt.billing.mandate.insufficient_funds",
  "evt.billing.mandate.canceled",
  "evt.billing.mandate.unlinked",
  "evt.billing.mandate.released",
] as const satisfies readonly Subject[];

type O = Record<string, unknown>;
const str = (o: O, k: string) => o[k] as string;

const OWNERS: readonly Role[] = ["owner"];

/** Billing subject → invoice template (spec `BILLING_EMAIL_TEMPLATES`, contract-tested). */
export const INVOICE_TEMPLATES = {
  "evt.billing.invoice.sent": "invoice.issued",
  "evt.billing.invoice.reminder": "invoice.reminder",
  "evt.billing.invoice.paid": "invoice.paid",
  "evt.billing.invoice.voided": "invoice.voided",
} as const satisfies Partial<Record<Subject, TemplateName>>;
const MANAGERS: readonly Role[] = ["owner", "admin"];

const unixIso = (v: unknown) => new Date((v as number) * 1000).toISOString();
const unixIsoOrNull = (v: unknown) => (typeof v === "number" ? unixIso(v) : null);

function destinationVariables(d: O, o: RoutingOptions) {
  return {
    label: (d.label as string | null) ?? null,
    chain: str(d, "chain"),
    chain_name: o.chainName(str(d, "chain")),
    address: str(d, "address"),
    asset_id: str(d, "asset_id"),
    fingerprint: str(d, "fingerprint"),
    dashboard_url: o.dashboardOrigin,
  };
}

/** Clock slack between `active_at` (whole seconds) and the envelope's `occurred_at`. */
const ACTIVE_NOW_SLACK_SECONDS = 60;

/**
 * True when a cooling-off destination has no wait: identity's cool-off is configurable
 * (`NP_COOLOFF_SECONDS`, 0 in the beta), so `active_at` equals the time the cool-off started.
 */
export function activeNow(activeAt: unknown, occurredAt: string | undefined): boolean {
  if (typeof activeAt !== "number" || !occurredAt) return false;
  const at = Date.parse(occurredAt) / 1000;
  return Number.isFinite(at) && activeAt - at <= ACTIVE_NOW_SLACK_SECONDS;
}

/** The plan for an event, or null when it sends nothing (with the reason in `skip`). */
export function planFor(e: RoutedEvent, o: RoutingOptions): { plan: Plan } | { skip: string } {
  const x = e.data.object as O;
  const lm = e.livemode;
  const account = (accountId: string, recipients: RecipientKind, roles?: readonly Role[]): Audience =>
    roles ? { kind: "account", accountId, recipients, roles } : { kind: "account", accountId, recipients };
  const plan = (
    template: TemplateName,
    audience: Audience,
    variables: O,
    accountId: string | null,
    extra: Pick<Plan, "userEmails"> = {},
  ) => ({
    plan: { template, audience, variables, accountId, livemode: lm, ...extra },
  });

  switch (e.subject as (typeof NOTIFY_SUBJECTS)[number]) {
    case "evt.identity.account.created":
      return plan(
        "account.welcome",
        account(str(x, "id"), "security", OWNERS),
        { account_name: str(x, "display_name"), dashboard_url: o.dashboardOrigin },
        str(x, "id"),
      );
    case "evt.identity.settlement_destination.cooling_off":
      return plan(
        "security.destination_pending",
        account(str(x, "account"), "security"),
        {
          ...destinationVariables(x, o),
          active_at: typeof x.active_at === "number" ? new Date((x.active_at as number) * 1000).toISOString() : null,
          active_now: activeNow(x.active_at, e.occurred_at),
        },
        str(x, "account"),
      );
    case "evt.identity.settlement_destination.activated":
      return plan(
        "security.destination_activated",
        account(str(x, "account"), "security"),
        destinationVariables(x, o),
        str(x, "account"),
      );
    case "evt.identity.settlement_destination.disabled":
      return plan(
        "security.destination_disabled",
        account(str(x, "account"), "security"),
        { ...destinationVariables(x, o), disabled_reason: (x.disabled_reason as string | null) ?? null },
        str(x, "account"),
      );
    case "evt.payments.payment_intent.succeeded":
      // step 3.1: an invoice payment is confirmed by `invoice.paid` (billing), not a second receipt
      if (x.source === "invoice" || typeof x.invoice === "string")
        return { skip: "invoice payment (invoice.paid mails it)" };
      if (lm === false && !o.testModeReceipts) return { skip: "test-mode receipts are off" };
      return plan(
        "payment.receipt",
        { kind: "customer", paymentIntentId: str(x, "id") },
        {
          payment_id: str(x, "id"),
          livemode: lm === true,
          destination_fingerprint: (() => {
            const d = x.destination as O | undefined;
            return d ? o.fingerprint(str(d, "chain"), str(d, "address"), str(d, "asset_id")) : null;
          })(),
        },
        null,
      );
    case "evt.compliance.kyb.approved":
    case "evt.compliance.kyb.rejected":
    case "evt.compliance.kyb.needs_info": {
      const status = str(x, "status");
      return plan(
        "kyb.decision",
        account(str(x, "account_id"), "security", OWNERS),
        {
          status,
          // only what ops asked for is shown; the decision `reason` is internal (audited), never mailed
          requested_info: status === "needs_info" ? ((x.requested_info as string | null | undefined) ?? null) : null,
          dashboard_url: o.dashboardOrigin,
        },
        str(x, "account_id"),
      );
    }
    case "evt.compliance.destination.blocked":
      return plan(
        "security.destination_blocked",
        account(str(x, "account_id"), "security"),
        { destination_id: str(x, "destination_id"), dashboard_url: o.dashboardOrigin },
        str(x, "account_id"),
      );
    case "evt.compliance.account.suspended":
    case "evt.compliance.account.reinstated":
      return plan(
        e.subject === "evt.compliance.account.suspended" ? "account.suspended" : "account.reinstated",
        account(str(x, "account_id"), "security", OWNERS),
        { dashboard_url: o.dashboardOrigin },
        str(x, "account_id"),
      );
    case "evt.compliance.review.opened":
    case "evt.compliance.review.closed": {
      const subject = x.subject as O;
      return plan(
        e.subject === "evt.compliance.review.opened" ? "review.opened" : "review.closed",
        account(str(x, "account_id"), "security"),
        {
          subject_type: str(subject, "type"),
          subject_id: str(subject, "id"),
          livemode: lm === true,
          dashboard_url: o.dashboardOrigin,
        },
        str(x, "account_id"),
      );
    }
    case "evt.sentinel.kill_switch.engaged":
    case "evt.sentinel.kill_switch.released":
      return plan(
        "ops.kill_switch",
        { kind: "security_contacts" },
        { engaged: e.subject === "evt.sentinel.kill_switch.engaged", reason: str(x, "reason"), actor: str(x, "actor") },
        null,
      );
    case "evt.sentinel.audit_finding.created":
      if (x.result === "pass") return { skip: "the finding passed" };
      // test-mode findings are expected (sandbox scenario 05) and stay in the case list
      if (x.livemode !== true) return { skip: "test-mode finding" };
      return plan(
        "ops.audit_finding",
        { kind: "security_contacts" },
        {
          finding_id: str(x, "id"),
          execution_id: str(x, "execution_id"),
          account_id: str(x, "account_id"),
          check_kind: str(x, "check_kind"),
          result: str(x, "result"),
        },
        str(x, "account_id"),
      );
    case "evt.webhooks.endpoint.disabled":
      return plan(
        "webhooks.endpoint_disabled",
        account(str(x, "account_id"), "developer"),
        {
          endpoint_id: str(x, "endpoint_id"),
          url: str(x, "url"),
          failing_since: str(x, "failing_since"),
          dashboard_url: o.dashboardOrigin,
        },
        str(x, "account_id"),
      );
    // stage 2
    case "evt.payments.refund.succeeded":
      if (lm === false && !o.testModeReceipts) return { skip: "test-mode receipts are off" };
      return plan(
        "refund.receipt",
        { kind: "refund_customer", refundId: str(x, "id") },
        { refund_id: str(x, "id"), payment_id: str(x, "payment_intent"), livemode: lm === true },
        null,
      );
    case "evt.identity.member.added":
    case "evt.identity.member.removed":
    case "evt.identity.member.role_changed": {
      const actor = (x.actor_user_id as string | null) ?? null;
      // identity audit fix (d): every owner/admin change reaches owners AND admins (the other managers
      // must see a puppet admin being added or a manager being removed); other roles: owners only
      const managerChange = [x.role, x.previous_role].some((r) => (MANAGERS as readonly unknown[]).includes(r));
      return plan(
        "security.member_changed",
        account(str(x, "account_id"), "security", managerChange ? MANAGERS : OWNERS),
        {
          change: e.subject.slice("evt.identity.member.".length),
          member_id: str(x, "user_id"),
          role: str(x, "role"),
          previous_role: (x.previous_role as string | null) ?? null,
          actor_id: actor,
          dashboard_url: o.dashboardOrigin,
        },
        str(x, "account_id"),
        { userEmails: { member_email: str(x, "user_id"), actor_email: actor } },
      );
    }
    case "evt.identity.settlement_destination.pending_approval": {
      const approval = (x.approval as O | null | undefined) ?? null;
      const approvedBy = (approval?.approved_by as string[] | undefined) ?? [];
      if (approval?.rejected_by) return { skip: "the destination was rejected" };
      // spec 0.2.1 `created_by`: the creator is never asked, even when not (yet) counted in approved_by
      const creator = typeof x.created_by === "string" ? [x.created_by] : [];
      return plan(
        "security.destination_approval",
        // the creator and earlier approvers cannot approve again
        {
          kind: "account",
          accountId: str(x, "account"),
          recipients: "security",
          exclude: [...new Set([...creator, ...approvedBy])],
        },
        {
          ...destinationVariables(x, o),
          approvals_required: (approval?.required as number | undefined) ?? 2,
          approvals_received: approvedBy.length,
        },
        str(x, "account"),
      );
    }
    case "evt.compliance.kyb.submitted":
      return plan(
        "kyb.submitted",
        account(str(x, "account_id"), "security", OWNERS),
        { submitted_at: str(x, "submitted_at"), dashboard_url: o.dashboardOrigin },
        str(x, "account_id"),
      );
    case "evt.compliance.account.action_requested":
    case "evt.sentinel.kill_switch.release_requested": {
      if (x.status !== "pending") return { skip: `the request is ${String(x.status)}` };
      const target = x.target as O;
      const requester = x.requested_by as O;
      return plan(
        "ops.approval_requested",
        { kind: "security_contacts" },
        {
          approval_id: str(x, "id"),
          action: str(x, "action"),
          target_type: str(target, "type"),
          target_id: str(target, "id"),
          reason: str(x, "reason") || "(no reason given)",
          requested_by: str(requester, "id"),
          requested_by_role: str(requester, "role"),
          requested_at: unixIso(x.requested_at),
          expires_at: unixIso(x.expires_at),
          console_url: o.consoleOrigin,
        },
        target.type === "account" ? str(target, "id") : null,
      );
    }
    // spec 0.2.1
    case "evt.identity.user.recovered": {
      const accounts = (x.account_ids as string[] | undefined) ?? [];
      if (accounts.length === 0) return { skip: "the user manages no account" };
      return plan(
        "security.recovery",
        // owners and admins of every locked account (the recovered user is one of them)
        { kind: "accounts", accountIds: accounts, recipients: "security", roles: MANAGERS },
        {
          user_id: str(x, "user_id"),
          recovered_at: str(x, "recovered_at"),
          lock_until: str(x, "lock_until"),
          dashboard_url: o.dashboardOrigin,
        },
        null,
        { userEmails: { user_email: str(x, "user_id") } },
      );
    }
    case "evt.webhooks.endpoint.secret_rotated": {
      const actor = (x.actor_user_id as string | null) ?? null;
      return plan(
        "webhooks.secret_rotated",
        // owners, admins and developers (identity `kind=developer`)
        account(str(x, "account_id"), "developer"),
        {
          endpoint_id: str(x, "endpoint_id"),
          url: str(x, "url"),
          previous_secret_expires_at: (x.previous_secret_expires_at as string | null) ?? null,
          actor_id: actor,
          livemode: lm === true,
          dashboard_url: o.dashboardOrigin,
        },
        str(x, "account_id"),
        { userEmails: { actor_email: actor } },
      );
    }
    // stage 3 — billing: the customer is resolved (and the status re-checked) from billing's context
    case "evt.billing.invoice.sent":
    case "evt.billing.invoice.reminder":
    case "evt.billing.invoice.paid":
    case "evt.billing.invoice.voided": {
      if (lm === false && !o.testModeReceipts) return { skip: "test-mode customer mails are off" };
      const template = INVOICE_TEMPLATES[e.subject as keyof typeof INVOICE_TEMPLATES];
      const reminder = e.subject === "evt.billing.invoice.reminder";
      const invoiceId = str(x, reminder ? "invoice" : "id");
      const transitions = (x.status_transitions as O | undefined) ?? {};
      const variables: O = reminder
        ? {
            // fallback when billing's context carries no reminder block
            reminder: {
              number: x.number as number,
              offset_days: x.offset_days as number,
              last: x.last === true,
            },
          }
        : e.subject === "evt.billing.invoice.paid"
          ? { paid_at: unixIsoOrNull(transitions.paid_at) }
          : e.subject === "evt.billing.invoice.voided"
            ? { voided_at: unixIsoOrNull(transitions.voided_at) }
            : {};
      return plan(
        template,
        { kind: "invoice_customer", invoiceId, reminder: reminder ? (x.number as number) : null },
        variables,
        null,
      );
    }
    case "evt.billing.subscription.renewal_upcoming":
      if (x.cancel_at_period_end === true) return { skip: "the subscription ends at the period end" };
      if (lm === false && !o.testModeReceipts) return { skip: "test-mode customer mails are off" };
      return plan(
        "subscription.renewal_upcoming",
        { kind: "subscription_customer", subscriptionId: str(x, "id") },
        // stage 4: an auto-debit renewal is collected from the mandate, not paid by hand
        { auto_debit: x.collection_method === "auto_debit" },
        null,
      );
    // stage 4 — mandate mails: the payer is resolved (and the status re-checked) from billing's context
    case "evt.billing.mandate.activated":
    case "evt.billing.mandate.insufficient_funds":
    case "evt.billing.mandate.canceled":
    case "evt.billing.mandate.unlinked":
    case "evt.billing.mandate.released":
      // nested-livemode guard: the mandate in the payload must be in the envelope's mode
      if (x.livemode !== lm) return { skip: "the mandate's mode differs from the event's" };
      if (lm === false && !o.testModeReceipts) return { skip: "test-mode customer mails are off" };
      return plan(
        MANDATE_TEMPLATES[e.subject as keyof typeof MANDATE_TEMPLATES],
        {
          kind: "mandate_customer",
          mandateId: str(x, "id"),
          subscriptionId: str(x, "subscription"),
          accountUuid: e.account_id ?? null,
        },
        {},
        null,
      );
    default:
      return { skip: `notify does not handle ${e.subject}` };
  }
}

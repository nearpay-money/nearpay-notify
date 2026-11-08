/**
 * Event fan-out (lld/notify.md §4): the consumer enqueues one `event.notify` job per event (inside
 * its inbox transaction); the job resolves the audience through the owner services — so an identity
 * or payments outage only delays mail, it never blocks the consumer — and queues one message per
 * recipient with the dedupe key `<event id>:<recipient>` (a retried job never sends twice).
 */
import type { Envelope } from "@nearpay-internal/bus";
import { withTx } from "@nearpay-internal/db";
import { toUuid } from "@nearpay-internal/ids";
import { chooseRecipients, lookupEmails, type Recipient } from "../domain/message/audience.js";
import { type InvoiceTemplate, invoiceMail, renewalMail } from "../domain/message/billing.js";
import { recipientHash } from "../domain/message/policy.js";
import { type Plan, planFor, type RoutingOptions } from "../domain/message/routing.js";
import type { Peers } from "../infra/clients/peers.js";
import type { Notify } from "./context.js";
import { queueMessage } from "./messages.js";

export const EVENT_JOB = "event.notify";
/** Identity/payments outages are retried for hours (backoff caps at 1 h) before a dead letter. */
export const EVENT_JOB_ATTEMPTS = 15;

export interface FanoutDeps {
  readonly n: Notify;
  readonly peers: Peers;
  readonly routing: RoutingOptions;
  readonly securityContacts: readonly string[];
}

interface Target {
  readonly key: string;
  readonly to: string;
  readonly variables: Record<string, unknown>;
  /** Account the message is filed under when the plan could not know it (billing contexts). */
  readonly accountId?: string;
}

async function targets(d: FanoutDeps, plan: Plan): Promise<Target[] | string> {
  const a = plan.audience;
  switch (a.kind) {
    case "account": {
      const list = await d.peers.recipients(a.accountId, a.recipients);
      if (list === null) return `identity does not know ${a.accountId}`;
      const variables = { ...plan.variables, ...(await emails(d, a.accountId, list, plan.userEmails)) };
      return chooseRecipients(list, a).map((r) => ({ key: r.user_id, to: r.email, variables }));
    }
    case "accounts": {
      const lists: Recipient[] = [];
      for (const accountId of a.accountIds) {
        const list = await d.peers.recipients(accountId, a.recipients);
        if (list) lists.push(...chooseRecipients(list, a));
      }
      const first = a.accountIds[0];
      if (lists.length === 0 || first === undefined) return "identity lists nobody for these accounts";
      const variables = { ...plan.variables, ...(await emails(d, first, lists, plan.userEmails)) };
      return chooseRecipients(lists, {}).map((r) => ({ key: r.user_id, to: r.email, variables }));
    }
    case "customer": {
      const ctx = await d.peers.receiptContext(a.paymentIntentId);
      if (ctx === null) return `payments does not know ${a.paymentIntentId}`;
      if (!ctx.email_receipts) return "the account turned receipts off";
      if (!ctx.customer_email) return "no customer email was collected";
      return [
        {
          key: "customer",
          to: ctx.customer_email,
          variables: {
            ...plan.variables,
            merchant_name: ctx.merchant_display_name,
            amount: ctx.amount,
            currency: ctx.currency,
            settled_display: ctx.settled.display,
            evidence_links: ctx.evidence_links.slice(0, 10),
          },
        },
      ];
    }
    case "refund_customer": {
      const ctx = await d.peers.refundReceiptContext(a.refundId);
      if (ctx === null) return `payments does not know ${a.refundId}`;
      if (!ctx.email_receipts) return "the account turned receipts off";
      if (!ctx.customer_email) return "no customer email is on record";
      // fail closed: a test refund never mails as live (or slips past the test-mode receipt switch)
      if (ctx.livemode !== (plan.livemode === true)) return "payments reports another mode for the refund";
      return [
        {
          key: "customer",
          to: ctx.customer_email,
          variables: {
            ...plan.variables,
            merchant_name: ctx.merchant_display_name,
            original_amount: ctx.original_amount,
            original_currency: ctx.original_currency,
            refunded_display: ctx.refunded.display,
            received_display: ctx.received?.display ?? null,
            recipient_display: ctx.recipient_display,
            evidence_links: ctx.evidence_links.slice(0, 10),
          },
        },
      ];
    }
    case "security_contacts":
      return d.securityContacts.map((to) => ({
        key: recipientHash(d.n.hashKey, to).subarray(0, 8).toString("hex"),
        to,
        variables: plan.variables,
      }));
    case "invoice_customer": {
      const ctx = await d.peers.invoiceContext(a.invoiceId, a.reminder);
      if (ctx === null) return `billing does not know ${a.invoiceId}`;
      const template = plan.template as InvoiceTemplate;
      // invoice.paid shows what settled and the on-chain proof (payments receipt context of the paying intent)
      const receipt =
        template === "invoice.paid" && ctx.payment_intent ? await d.peers.receiptContext(ctx.payment_intent) : null;
      const r = invoiceMail(template, ctx, {
        invoiceId: a.invoiceId,
        livemode: plan.livemode,
        variables: plan.variables,
        receipt: receipt ? { settled_display: receipt.settled.display, evidence_links: receipt.evidence_links } : null,
      });
      return "skip" in r ? r.skip : [{ key: "customer", to: r.to, variables: r.variables, accountId: r.accountId }];
    }
    case "subscription_customer": {
      const ctx = await d.peers.subscriptionContext(a.subscriptionId);
      if (ctx === null) return `billing does not know ${a.subscriptionId}`;
      const r = renewalMail(ctx, {
        subscriptionId: a.subscriptionId,
        livemode: plan.livemode,
        variables: plan.variables,
      });
      return "skip" in r ? r.skip : [{ key: "customer", to: r.to, variables: r.variables, accountId: r.accountId }];
    }
  }
}

/**
 * `userEmails` variables: from the recipient list when the user is on it, else identity `?user=`
 * (spec 0.2.1: names members of any role, and recently removed ones), else null.
 */
async function emails(
  d: FanoutDeps,
  accountId: string,
  list: readonly Recipient[],
  userEmails: Plan["userEmails"],
): Promise<Record<string, string | null>> {
  const out = lookupEmails(list, userEmails);
  for (const [k, id] of Object.entries(userEmails ?? {}))
    if (out[k] === null && id !== null) out[k] = (await d.peers.recipient(accountId, id))?.email ?? null;
  return out;
}

/** Runs the `event.notify` job for one envelope. */
export async function fanOut(d: FanoutDeps, e: Envelope): Promise<{ queued: number; skipped?: string }> {
  const r = planFor(e, d.routing);
  if ("skip" in r) return { queued: 0, skipped: r.skip };
  const t = await targets(d, r.plan);
  if (typeof t === "string" || t.length === 0) {
    const skipped = typeof t === "string" ? t : "no recipients";
    d.n.log.info({ event: e.id, subject: e.subject, template: r.plan.template, skipped }, "nothing to send");
    return { queued: 0, skipped };
  }
  const plan = r.plan;
  const queued = await withTx(d.n.db, async (tx) => {
    let n = 0;
    for (const x of t) {
      const q = await queueMessage(d.n, tx, {
        template: plan.template,
        to: x.to,
        variables: x.variables,
        locale: "en",
        dedupeKey: `${e.id}:${x.key}`,
        source: `event:${e.subject}`,
        accountUuid: (x.accountId ?? plan.accountId) ? toUuid((x.accountId ?? plan.accountId) as string, "acct") : null,
        livemode: plan.livemode,
      });
      if (q.created) n++;
    }
    return n;
  });
  return { queued };
}

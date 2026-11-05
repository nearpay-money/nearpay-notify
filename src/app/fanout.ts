/**
 * Event fan-out (lld/notify.md §4): the consumer enqueues one `event.notify` job per event (inside
 * its inbox transaction); the job resolves the audience through the owner services — so an identity
 * or payments outage only delays mail, it never blocks the consumer — and queues one message per
 * recipient with the dedupe key `<event id>:<recipient>` (a retried job never sends twice).
 */
import type { Envelope } from "@nearpay-internal/bus";
import { withTx } from "@nearpay-internal/db";
import { toUuid } from "@nearpay-internal/ids";
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
}

async function targets(d: FanoutDeps, plan: Plan): Promise<Target[] | string> {
  const a = plan.audience;
  switch (a.kind) {
    case "account": {
      const list = await d.peers.recipients(a.accountId, a.recipients);
      if (list === null) return `identity does not know ${a.accountId}`;
      const chosen = a.roles ? list.filter((r) => (a.roles as readonly string[]).includes(r.role)) : list;
      return chosen.map((r) => ({ key: r.user_id, to: r.email, variables: plan.variables }));
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
    case "security_contacts":
      return d.securityContacts.map((to) => ({
        key: recipientHash(d.n.hashKey, to).subarray(0, 8).toString("hex"),
        to,
        variables: plan.variables,
      }));
  }
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
        accountUuid: plan.accountId ? toUuid(plan.accountId, "acct") : null,
        livemode: plan.livemode,
      });
      if (q.created) n++;
    }
    return n;
  });
  return { queued };
}

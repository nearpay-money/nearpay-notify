/** A spec-valid `Refund` for event tests (kit 0.1.x has no refund factory; parsed against spec 0.2.0). */

import { newId } from "@nearpay-internal/ids";
import { Refund } from "@nearpay-money/spec";

export function refund(over: Partial<Record<keyof Refund, unknown>> = {}): Refund {
  const now = Math.floor(Date.now() / 1000);
  return Refund.parse({
    id: newId("re"),
    object: "refund",
    created: now - 600,
    livemode: true,
    status: "succeeded",
    payment_intent: newId("pi"),
    payment_attempt: newId("pa"),
    amount: "25000000",
    asset_id: "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near",
    decimals: 6,
    fee_mode: "payer_absorbs",
    reason: "requested_by_customer",
    method: "intents_transfer",
    recipient: {
      address: "buyer.near",
      asset_id: "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near",
      chain: "near:mainnet",
      type: "intents",
      overridden: false,
    },
    next_action: null,
    legs: [],
    amount_received: "25000000",
    evidence: null,
    extra_amount_sent: "0",
    source: "dashboard",
    failure_code: null,
    succeeded_at: now,
    canceled_at: null,
    sequence: 3,
    metadata: {},
    ...over,
  });
}

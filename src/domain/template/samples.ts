/**
 * Sample variables for every template: the startup self-check renders each one (a broken layout or
 * template fails readiness, not a send) and the snapshot tests pin their output.
 */
import type { TemplateName, Variables } from "./catalogue.js";

const DASHBOARD = "https://dashboard.nearpay.localhost";
const destination = {
  label: "Treasury (Base)",
  chain: "eip155:8453",
  chain_name: "Base",
  address: "0x52908400098527886e0f7030069857d2e4169ee7",
  asset_id: "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near",
  fingerprint: "7KQ2-M9XA-31",
  dashboard_url: DASHBOARD,
};

export const SAMPLES: { readonly [T in TemplateName]: readonly Variables<T>[] } = {
  "auth.magic_link": [
    { link_url: "https://dashboard.nearpay.localhost/auth/magic?token=abc", purpose: "signup", expires_in_minutes: 15 },
    {
      link_url: "https://dashboard.nearpay.localhost/auth/magic?token=def",
      purpose: "recovery",
      expires_in_minutes: 15,
    },
    {
      link_url: "https://dashboard.nearpay.localhost/auth/magic?token=ghi",
      purpose: "invite",
      expires_in_minutes: 1440,
    },
  ],
  "account.welcome": [{ account_name: "Acme Test Shop", dashboard_url: DASHBOARD }],
  "security.destination_pending": [
    { ...destination, active_at: "2026-11-06T10:00:00.000Z" },
    { ...destination, label: null, active_at: null },
  ],
  "security.destination_activated": [destination],
  "security.destination_disabled": [
    { ...destination, disabled_reason: "merchant" },
    { ...destination, disabled_reason: null },
  ],
  "security.destination_blocked": [{ destination_id: "sd_01m6pm3ppnengb0aaefsa11e3j", dashboard_url: DASHBOARD }],
  "kyb.decision": [
    { status: "approved", reason: null, dashboard_url: DASHBOARD },
    { status: "rejected", reason: null, dashboard_url: DASHBOARD },
    {
      status: "needs_info",
      reason: "Upload a commercial register extract dated within 3 months.",
      dashboard_url: DASHBOARD,
    },
  ],
  "account.suspended": [{ dashboard_url: DASHBOARD }],
  "account.reinstated": [{ dashboard_url: DASHBOARD }],
  "review.opened": [
    {
      subject_type: "execution",
      subject_id: "ex_01m6pm3ppnengb0aaefsa11e3j",
      livemode: true,
      dashboard_url: DASHBOARD,
    },
  ],
  "review.closed": [
    {
      subject_type: "agent_payment",
      subject_id: "ap_01m6pm3ppnengb0aaefsa11e3j",
      livemode: false,
      dashboard_url: DASHBOARD,
    },
  ],
  "payment.receipt": [
    {
      payment_id: "pi_01m6pm3ppnengb0aaefsa11e3j",
      merchant_name: "Acme Test Shop",
      amount: 2500,
      currency: "usd",
      settled_display: "25.00 USDC (NEAR)",
      destination_fingerprint: "YZMN-R81Z-BR",
      evidence_links: ["https://nearblocks.io/txns/8Ld3Ap4zR2yK7uR3nVbXq1sH4cW9tE6mP2fJ5gD1aB7c"],
      livemode: true,
    },
    {
      payment_id: "pi_01m6pm3ppnengb0aaefsa11e3k",
      merchant_name: "Acme <Test> & Co",
      amount: "2000000",
      currency: "asset",
      settled_display: "2.00 USDC (Base)",
      destination_fingerprint: null,
      evidence_links: [],
      livemode: false,
    },
  ],
  "ops.kill_switch": [
    { engaged: true, reason: "verifier mismatch rate above threshold", actor: "sentinel" },
    { engaged: false, reason: "reviewed and resolved", actor: "ops:usr_alice" },
  ],
  "ops.audit_finding": [
    {
      finding_id: "fnd_01m6pm3ppnengb0aaefsa11e3j",
      execution_id: "ex_01m6pm3ppnengb0aaefsa11e3j",
      account_id: "acct_01m6pm3ppnengb0aaefsa11e3j",
      check_kind: "settlement_transfer",
      result: "mismatch",
    },
  ],
  "webhooks.endpoint_disabled": [
    {
      endpoint_id: "we_01m6pm3ppnengb0aaefsa11e3j",
      url: "https://merchant.example/webhooks/nearpay",
      failing_since: "2026-11-02T08:15:00.000Z",
      dashboard_url: DASHBOARD,
    },
  ],
};

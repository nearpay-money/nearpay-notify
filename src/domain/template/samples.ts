/**
 * Sample variables for every template: the startup self-check renders each one (a broken layout or
 * template fails readiness, not a send) and the snapshot tests pin their output.
 */
import type { TemplateName, Variables } from "./catalogue.js";

const DASHBOARD = "https://dashboard.nearpay.localhost";
const CONSOLE = "https://ops.nearpay.localhost";
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
    { status: "approved", requested_info: null, dashboard_url: DASHBOARD },
    { status: "rejected", requested_info: null, dashboard_url: DASHBOARD },
    {
      status: "needs_info",
      requested_info: "Add the registration number shown on your company register entry.",
      dashboard_url: DASHBOARD,
    },
    { status: "needs_info", requested_info: null, dashboard_url: DASHBOARD },
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
  "refund.receipt": [
    {
      refund_id: "re_01m6pm3ppnengb0aaefsa11e3j",
      payment_id: "pi_01m6pm3ppnengb0aaefsa11e3j",
      merchant_name: "Acme Test Shop",
      original_amount: 2500,
      original_currency: "usd",
      refunded_display: "25.00 USDC (Base)",
      received_display: "24.91 USDT (Arbitrum)",
      recipient_display: "0xab12…9fcd on Arbitrum",
      evidence_links: ["https://arbiscan.io/tx/0x5c1f0e3a9b7d2c4e6f8a0b1c3d5e7f9a1b3c5d7e9f0a2b4c6d8e0f1a3b5c7d9e"],
      livemode: true,
    },
    {
      refund_id: "re_01m6pm3ppnengb0aaefsa11e3k",
      payment_id: "pi_01m6pm3ppnengb0aaefsa11e3k",
      merchant_name: "Acme <Test> & Co",
      original_amount: "2000000",
      original_currency: "asset",
      refunded_display: "2.00 USDC (Base)",
      received_display: null,
      recipient_display: "acme-buyer.near (NEAR Intents)",
      evidence_links: [],
      livemode: false,
    },
  ],
  "security.member_changed": [
    {
      change: "added",
      member_id: "usr_01m6pm3ppnengb0aaefsa11e3j",
      member_email: "dana@acme.example",
      role: "admin",
      previous_role: null,
      actor_id: "usr_01m6pm3ppnengb0aaefsa11e3k",
      actor_email: "owner@acme.example",
      dashboard_url: DASHBOARD,
    },
    {
      change: "added",
      member_id: "usr_01m6pm3ppnengb0aaefsa11e3m",
      member_email: null,
      role: "developer",
      previous_role: null,
      actor_id: null,
      actor_email: null,
      dashboard_url: DASHBOARD,
    },
    {
      change: "removed",
      member_id: "usr_01m6pm3ppnengb0aaefsa11e3m",
      member_email: null,
      role: "developer",
      previous_role: null,
      actor_id: "usr_01m6pm3ppnengb0aaefsa11e3k",
      actor_email: "owner@acme.example",
      dashboard_url: DASHBOARD,
    },
    {
      change: "role_changed",
      member_id: "usr_01m6pm3ppnengb0aaefsa11e3j",
      member_email: "dana@acme.example",
      role: "owner",
      previous_role: "admin",
      actor_id: "usr_01m6pm3ppnengb0aaefsa11e3k",
      actor_email: null,
      dashboard_url: DASHBOARD,
    },
  ],
  "team.invitation": [
    {
      link_url: "https://dashboard.nearpay.localhost/auth/invite#token=jkl",
      account_display_name: "Acme Test Shop",
      role: "finance",
      expires_in_minutes: 10_080,
    },
  ],
  "ops.enrolment": [
    { link_url: "https://ops.nearpay.localhost/auth/enrol#token=mno", role: "ops_admin", expires_in_minutes: 1440 },
    { link_url: "https://ops.nearpay.localhost/auth/enrol#token=pqr", role: "ops", expires_in_minutes: 90 },
  ],
  "security.destination_approval": [{ ...destination, approvals_required: 2, approvals_received: 1 }],
  "kyb.submitted": [{ submitted_at: "2026-11-07T09:30:00.000Z", dashboard_url: DASHBOARD }],
  "ops.approval_requested": [
    {
      approval_id: "opa_01m6pm3ppnengb0aaefsa11e3j",
      action: "account.suspend",
      target_type: "account",
      target_id: "acct_01m6pm3ppnengb0aaefsa11e3j",
      reason: "Chargeback-style complaints from three payers; pausing while we investigate.",
      requested_by: "usr_01m6pm3ppnengb0aaefsa11e3n",
      requested_by_role: "ops",
      requested_at: "2026-11-07T10:00:00.000Z",
      expires_at: "2026-11-08T10:00:00.000Z",
      console_url: CONSOLE,
    },
    {
      approval_id: "opa_01m6pm3ppnengb0aaefsa11e3k",
      action: "kill_switch.release",
      target_type: "kill_switch",
      target_id: "ks_global",
      reason: "Verifier mismatch explained by an RPC outage; checks green for 30 minutes.",
      requested_by: "usr_01m6pm3ppnengb0aaefsa11e3p",
      requested_by_role: "ops_admin",
      requested_at: "2026-11-07T10:00:00.000Z",
      expires_at: "2026-11-07T11:00:00.000Z",
      console_url: CONSOLE,
    },
  ],
};

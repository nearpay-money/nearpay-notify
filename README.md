# nearpay-notify

> Transactional email (receipts, invoices, dunning, security alerts) with primary/fallback providers.

|                                       |                                                     |
| ------------------------------------- | --------------------------------------------------- |
| Group                                 | Services                                            |
| Kind                                  | service                                             |
| Ships as                              | image: ghcr.io/nearpay-money/notify · internal only |
| Owns                                  | Message, Template                                   |
| Depends on (published artifacts only) | spec, kit, email providers                          |
| First built in                        | Stage 1 (step 1.2)                                  |

## Documentation

This repo stays surgical: design docs live in [`nearpay-brain`](../nearpay-brain/README.md), not here.

- `nearpay-brain/lld/notify.md` — **low-level design (dev-ready; implement from this)**
- `nearpay-brain/lld/audits/notify.md` — audit findings already folded into the LLD
- `nearpay-brain/roadmap/development-plan.md` — stage and step this repo is built in
- `nearpay-brain/architecture/hld.md` — system design
- `nearpay-brain/architecture/repositories.md` — repo topology and dependency rules
- `nearpay-brain/architecture/hld.md`

## Layout

```
nearpay-notify/
├── src/
│   ├── main.ts               process entry: `api` | `worker` | `migrate` | `healthcheck`
│   ├── config.ts             NP_* configuration (secrets from files)
│   ├── api/                  `POST /internal/messages` (scope `notify.send`)
│   ├── app/                  queueing, event fan-out, the send job, rendering (MJML), process wiring
│   ├── consumers/            one inbox-deduplicated handler per subject: enqueue the fan-out job
│   ├── domain/
│   │   ├── message/          pure: event → template/audience routing, retry/fallback/suppression policy
│   │   └── template/         pure: template catalogue (zod variables, copy per locale), blocks, escaping, samples
│   ├── infra/                Kysely schema, migrations path, identity/payments/billing clients
│   ├── providers/            provider port + SMTP (Mailpit locally); Postmark/SES arrive in Stage 5
│   └── workers/              jobs: event.notify, message.send, purges
├── templates/email/          shared MJML layout (copied into the image)
├── migrations/               plain SQL (kit tables first, then 0001_notify.sql)
├── test/
│   ├── unit/ property/       routing, policy, escaping, rendering; snapshot per template and locale
│   ├── __snapshots__/        rendered subject + text + HTML of every template sample
│   ├── integration/          api, worker end to end (NATS → spec-mocked identity/payments/billing → real Mailpit), send job
│   └── contract/             route/subject coverage, response/error shapes, peer scopes
└── Dockerfile                distroless Node 22 image, `node dist/main.js <process>`
```

## Commands

| Command                                                                                                   | What it does                                                                                                                                              |
| --------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm install`                                                                                            | Install (Node 22, pnpm 9); `@nearpay-money/*` and `@nearpay-internal/*` come from the local registry (`.npmrc`, `nearpay-deploy/scripts/up.sh` starts it) |
| `pnpm test`                                                                                               | Unit, property and template snapshot tests                                                                                                                |
| `pnpm test:integration`                                                                                   | Integration and contract tests on real Postgres, NATS and Mailpit (Testcontainers; needs Docker)                                                          |
| `pnpm verify`                                                                                             | typecheck + lint + unit tests with the coverage gate + integration tests + build                                                                          |
| `docker build --network host --build-arg NP_REGISTRY_URL=http://127.0.0.1:4873 -t nearpay/notify:local .` | Image (what `up.sh` runs)                                                                                                                                 |

After an intended copy or layout change, refresh the snapshots with `pnpm test -- -u` and review the diff.

## Configuration

| Variable                                       | Process     | Meaning                                                                                                                                                                                                                                     |
| ---------------------------------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `NP_DB_URL_FILE`                               | all         | Database URL (app role for `api`/`worker`, migrator role for `migrate`)                                                                                                                                                                     |
| `NP_PII_KEK_FILE`                              | api, worker | 32-byte KEK: recipients and variables are envelope-encrypted; the recipient-hash key derives from it                                                                                                                                        |
| `NP_JWKS_URL`                                  | api         | identity's JWKS (verifies service tokens)                                                                                                                                                                                                   |
| `NP_NATS_URL`                                  | worker      | NATS JetStream                                                                                                                                                                                                                              |
| `NP_EMAIL_PROVIDER`                            | worker      | `smtp` (Stage 1)                                                                                                                                                                                                                            |
| `NP_SMTP_URL`                                  | worker      | `smtp://mailpit:1025` locally; beta `smtps://smtp.resend.com:465`. `smtps` = implicit TLS, `smtp` = STARTTLS (required off local/test). No password in the URL on the server stage                                                          |
| `NP_SMTP_USER`, `NP_SMTP_PASSWORD_FILE`        | worker      | SMTP credentials (Resend: `resend` + the API key in a secret file)                                                                                                                                                                          |
| `NP_FROM`                                      | worker      | `NearPay <no-reply@nearpay.money>`                                                                                                                                                                                                          |
| `NP_REPLY_TO`                                  | worker      | `Reply-To` of every mail (optional)                                                                                                                                                                                                         |
| `NP_EMAIL_DAILY_CAP`, `NP_EMAIL_DAILY_RESERVE` | worker      | Sends per UTC day (0 = off) and the slots kept for sign-in/security/ops mail (default 10). Over the cap other mail is deferred to the next UTC day; metrics `nearpay_notify_email_capped_total`, `nearpay_notify_email_daily_cap_remaining` |
| `NP_SECURITY_CONTACTS`                         | worker      | Comma-separated ops recipients of kill-switch, audit-finding and approval-request alerts                                                                                                                                                    |
| `NP_TEST_MODE_RECEIPTS`                        | worker      | Customer receipts for test-mode payments (default `false`; Compose local sets `true`)                                                                                                                                                       |
| `NP_DASHBOARD_ORIGIN`                          | worker      | Link target in merchant mails                                                                                                                                                                                                               |
| `NP_CONSOLE_ORIGIN`                            | worker      | Link target in ops approval mails (default `https://ops.nearpay.localhost`)                                                                                                                                                                 |
| `NP_IDENTITY_URL`, `NP_PAYMENTS_URL`           | worker      | Recipient resolution (`notification-recipients`, payment and refund `receipt-context`)                                                                                                                                                      |
| `NP_BILLING_URL`                               | worker      | Billing mails (stage 3–4): invoice, subscription and mandate `notification-context`                                                                                                                                                         |
| `NP_SERVICE_CLIENT_SECRET_FILE`                | worker      | notify's service-client secret (client id `notify`)                                                                                                                                                                                         |
| `NP_SEND_TIMEOUT_MS`                           | worker      | Provider timeout (default 5000)                                                                                                                                                                                                             |
| `NP_RECIPIENT_HOURLY_LIMIT`                    | worker      | Sends per recipient per hour (default 20)                                                                                                                                                                                                   |
| `NP_MESSAGE_RETENTION_DAYS`                    | worker      | Messages are deleted after this many days (default 90)                                                                                                                                                                                      |

## Behaviour

- **API** (`POST /internal/messages`, identity and billing; templates `auth.magic_link`, `team.invitation`, `ops.enrolment`): validates the template's variables, stores one message (recipient and variables envelope-encrypted, recipient HMAC-hashed) and its send job in one transaction, returns `202 {message_id}`. The same `dedupe_key` returns the same message.
- **Events** (all 37 subjects the catalogue routes to notify): the consumer only enqueues an `event.notify` job inside its inbox transaction. The job resolves the audience — identity `notification-recipients` (security: owners + admins, filtered to owners where the LLD says so, minus users who already approved a destination; developer: + developers), payments `receipt-context` for the customer (payment or refund), billing `notification-context` for an invoice's, subscription's (stage 3) or mandate's (stage 4) customer, or `NP_SECURITY_CONTACTS` — and queues one message per recipient with the dedupe key `<event id>:<recipient>`. Identity or payments outages delay mail (job backoff); they never block the consumer.
- **Sending** (`message.send`): suppression list, then at most 20 sends per recipient per hour, then render (MJML, strict), then the provider (5 s). Transient failures retry with backoff for 8 attempts, then the fallback provider (Stage 5) for 2; permanent failures end the message as `failed`, and a rejected recipient (SMTP 550/551/553) is suppressed. Every mail carries `Message-ID: <message uuid@domain>` so an at-least-once re-send is recognisable. A sent magic, invitation or enrolment link's variables are wiped.
- **Billing mails** (stage 3, spec 0.3.0 `BILLING_EMAIL_TEMPLATES`): `evt.billing.invoice.sent|reminder|paid|voided` → `invoice.issued|reminder|paid|voided`, `evt.billing.subscription.renewal_upcoming` → `subscription.renewal_upcoming`, all to the customer. Events carry ids only: the job reads billing's context (customer email, merchant name, amounts, lines and the hosted invoice link with the invoice secret; `?reminder=<n>` for reminders) and sends nothing when the context names another object, its mode differs from the event's, there is no customer email, the status no longer fits (e.g. a reminder for an invoice paid meanwhile) or an issue/reminder mail has no link. `invoice.paid` adds the paying intent's settlement and on-chain proof (payments `receipt-context`); an invoice's `payment_intent.succeeded` sends no separate receipt. Test-mode billing mails follow `NP_TEST_MODE_RECEIPTS`. The hosted link is wiped from the message once sent and never logged.
- **Mandate mails** (stage 4, spec 0.4.0): `evt.billing.mandate.activated|insufficient_funds|canceled|unlinked|released` → `mandate.<same>` to the payer (customer), from billing's mandate `notification-context`. Fail closed on another mandate/subscription/account, another mode (also the payload's own `livemode`), no email, a status that no longer fits, a missing cancel call where the mail must show it (activation, unlinked, released), or a payer transaction that does not call the mandate's own vault. The activation mail always spells out the cancel call (FR-BIL-04); every mandate mail says NearPay never holds the funds (INV-1). `manage_url` (hosted link with the invoice secret) is wiped once sent.
- **Copy rules**: security mails always show the destination fingerprint; receipts show the fingerprint of the destination the payment settled to; internal compliance reasons are never shown to merchants (only what ops asked for in a KYB `needs_info`); KYB is self-declared business details that go live at once (open onboarding, ADR-0024: `kyb.submitted` sends nothing, the approval mail is the "You're live" welcome), so no mail says "verified" or promises a review; refund mails say the merchant sent the funds from their own wallet; test-mode mails say so; every value is HTML-escaped and only absolute http(s) links render. Look and wording follow the NearPay design system (`nearpay-brain/product/design-system.md`: deep ink text, teal actions, DM Sans with system fallbacks).
- **Templates** (`en`): `auth.magic_link` · `account.welcome` · `security.destination_pending|activated|disabled|blocked` · `security.destination_approval` · `security.member_changed` · `team.invitation` · `kyb.submitted` · `kyb.decision` · `account.suspended|reinstated` · `review.opened|closed` · `payment.receipt` · `refund.receipt` · `ops.enrolment` · `ops.approval_requested` · `ops.kill_switch` · `ops.audit_finding` · `webhooks.endpoint_disabled` · `webhooks.secret_rotated` · `security.recovery` · `invoice.issued` · `invoice.reminder` · `invoice.paid` · `invoice.voided` · `subscription.renewal_upcoming`. The worker renders every sample at startup and refuses to start if one fails.

## Status

Stage 1 (step 1.2) implemented: the Stage-1 notify route and every subject `@nearpay-internal/spec` 0.1.2 routes to notify, SMTP delivery (Mailpit), dedupe, suppression, limits and retention. Stage 2 (step 2.2, spec 0.2.0): refund receipts, member, invitation, operator-enrolment, destination-approval, KYB-submitted and ops approval-request mails; brand restyle and self-declared KYB wording. Stage 3 (step 3.2, spec 0.3.0, kit 0.2.1): billing mails (invoice issued, reminder, paid, voided; subscription renewal upcoming). Stage 4 (step 4.2, spec 0.4.0): mandate mails to the payer; auto-debit wording in the renewal mail. Postmark/SES and bounce webhooks (`/webhooks/email/postmark`) arrive in Stage 5; more locales need only a copy table.

## Built with

TypeScript 5, Node 22, `@nearpay-internal/*` kit (service, db, bus, http, auth, chains, money, ids), `mjml` (email layout), `nodemailer` (SMTP), Kysely + pg, NATS JetStream; tests with Vitest, fast-check, Testcontainers and Mailpit. Code and documentation are written with AI assistance (Claude) under human direction and review.

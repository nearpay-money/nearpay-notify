# AGENTS.md — nearpay-notify

You are working in **nearpay-notify**, one of 26 NearPay repositories (`nearpay-brain/architecture/repositories.md`).
Scope: Transactional email (receipts, invoices, dunning, security alerts) with primary/fallback providers.

## Before changing anything

1. Read `../nearpay-brain/AGENTS.md`, then this repo's LLD (`../nearpay-brain/lld/notify.md`) — it is the implementation spec; do not make design decisions it already makes.
2. Contracts (requests, responses, events, errors) come from `@nearpay-money/spec`. If one must change, open a PR in `nearpay-spec` first; never hand-write contract types here.
3. Check your change against invariants INV-1…INV-9 in `nearpay-brain/product/requirements.md`.

## Rules for this repo

- Hexagonal layout: `src/domain` is pure (routing, policy, template copy); `src/app` holds use cases; `src/providers` adapts email providers; `src/infra` adapts the DB and peer services; `src/api` maps spec routes to use cases.
- Events carry no PII: resolve recipients through identity/payments (or the configured ops contacts), never from payloads. Consumers only enqueue jobs inside the inbox transaction; network calls happen in jobs.
- Every message is deduplicated (`<template>:<key>`, event messages `<event id>:<recipient>`); a retried job or redelivered event never sends twice (INV-4).
- Recipients and variables are envelope-encrypted at rest; log message ids and templates, never addresses or variables.
- Escape every variable; render only absolute http(s) links; subjects are single-line. Never show internal compliance reasons to merchants.
- A copy or layout change updates `test/__snapshots__` in the same commit (review the rendered diff); every template has samples in `src/domain/template/samples.ts`.
- Keep ≥ 90% branch coverage on `src/domain`.

## Never

- Import source code from another NearPay repo (depend on published packages/images only).
- Read or write another service's database.
- Add design documents here — update `nearpay-brain` and link to it.
- Commit secrets, private keys or real customer data.
- Merge changes to paths listed in `.github/CODEOWNERS` without the required human review.

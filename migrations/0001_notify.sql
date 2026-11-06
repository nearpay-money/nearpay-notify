-- nearpay-notify (lld/notify.md §3): messages (one per recipient and template, PII encrypted) and
-- suppressions. Sends and event fan-out run as kit jobs (`message.send`, `event.notify`).

create table messages (
  id uuid primary key,
  account_id uuid,
  livemode boolean,
  template text not null,
  locale text not null default 'en',
  to_hash bytea not null,                                -- HMAC-SHA256 of the lower-cased address (KEK-derived key)
  to_enc bytea not null,                                 -- envelope-encrypted recipient
  variables_enc bytea not null,                          -- envelope-encrypted template variables (JSON)
  status text not null check (status in ('queued','sent','failed','suppressed')),
  provider text,
  provider_message_id text,
  attempts smallint not null default 0,
  dedupe_key text unique,                                -- `<template>:<caller dedupe key>`
  source text not null,                                  -- 'api' | 'event:<subject>'
  last_error text,
  created_at timestamptz not null default now(),
  sent_at timestamptz,
  updated_at timestamptz not null default now());
-- per-recipient rate limit (20 / hour) and history
create index messages_recipient on messages (to_hash, created_at desc);
create index messages_status on messages (status, created_at);

create table suppressions (
  to_hash bytea primary key,
  reason text not null check (reason in ('hard_bounce','complaint','manual')),
  detail text,
  created_at timestamptz not null default now());

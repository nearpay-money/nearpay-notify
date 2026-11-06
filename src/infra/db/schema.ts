/** Kysely table types (migrations/0001_notify.sql). */
import type { ColumnType, Generated, KitTables } from "@nearpay-internal/db";

type Timestamp = ColumnType<Date, Date | string | undefined, Date | string>;
type NullableTimestamp = ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;

export type MessageStatus = "queued" | "sent" | "failed" | "suppressed";

export interface MessagesTable {
  id: string;
  account_id: string | null;
  livemode: boolean | null;
  template: string;
  locale: Generated<string>;
  to_hash: Buffer;
  to_enc: Buffer;
  variables_enc: Buffer;
  status: MessageStatus;
  provider: string | null;
  provider_message_id: string | null;
  attempts: Generated<number>;
  dedupe_key: string | null;
  source: string;
  last_error: string | null;
  created_at: Timestamp;
  sent_at: NullableTimestamp;
  updated_at: Timestamp;
}

export interface SuppressionsTable {
  to_hash: Buffer;
  reason: "hard_bounce" | "complaint" | "manual";
  detail: string | null;
  created_at: Timestamp;
}

export interface NotifyTables {
  messages: MessagesTable;
  suppressions: SuppressionsTable;
}

export type DB = NotifyTables & KitTables;

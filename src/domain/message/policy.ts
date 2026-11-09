/**
 * Sending policy (lld/notify.md §6). Pure.
 *
 * - recipients are hashed with a keyed HMAC (suppressions and rate limits without storing addresses);
 * - a transient failure retries with backoff on the primary provider for 8 attempts, then moves to
 *   the fallback provider (Stage 5: SES) for 2 more; without a fallback the 8th failure is final;
 * - a permanent failure is final at once; a rejected recipient is also suppressed (hard bounce);
 * - at most `limit` sends per recipient per hour (magic-link abuse cannot mail-bomb an inbox);
 * - optionally at most `DailyCap.limit` sends per UTC day overall, with a reserve for essential mail.
 */
import { createHmac, hkdfSync } from "node:crypto";

export const PRIMARY_ATTEMPTS = 8;
export const FALLBACK_ATTEMPTS = 2;

/** Lower-cased, trimmed address (delivery is case-insensitive in practice; the hash must be too). */
export function normalizeAddress(to: string): string {
  return to.trim().toLowerCase();
}

/** Key for recipient hashes, derived from the KEK (never the KEK itself). */
export function recipientHashKey(kek: Buffer): Buffer {
  return Buffer.from(hkdfSync("sha256", kek, Buffer.alloc(0), "nearpay-notify:recipient-hash", 32));
}

export function recipientHash(key: Buffer, to: string): Buffer {
  return createHmac("sha256", key).update(normalizeAddress(to)).digest();
}

export type ProviderSlot = "primary" | "fallback";

/** Provider for a 1-based job attempt, or null when no attempt is left. */
export function providerFor(attempt: number, hasFallback: boolean): ProviderSlot | null {
  if (attempt <= PRIMARY_ATTEMPTS) return "primary";
  if (hasFallback && attempt <= PRIMARY_ATTEMPTS + FALLBACK_ATTEMPTS) return "fallback";
  return null;
}

/** Job attempts to allow for a message. */
export function maxAttempts(hasFallback: boolean): number {
  return PRIMARY_ATTEMPTS + (hasFallback ? FALLBACK_ATTEMPTS : 0);
}

export interface SendFailure {
  /** Retrying cannot help (bad address, rejected content, auth). */
  readonly permanent: boolean;
  /** The recipient itself was rejected (suppress it). */
  readonly recipientRejected: boolean;
  readonly message: string;
}

export type FailureOutcome = { readonly kind: "retry" } | { readonly kind: "failed"; readonly suppress: boolean };

/** What to do after a failed attempt. */
export function afterFailure(f: SendFailure, attempt: number, hasFallback: boolean): FailureOutcome {
  if (f.permanent) return { kind: "failed", suppress: f.recipientRejected };
  return attempt >= maxAttempts(hasFallback) ? { kind: "failed", suppress: false } : { kind: "retry" };
}

export function overHourlyLimit(sentLastHour: number, limit: number): boolean {
  return sentLastHour >= limit;
}

/**
 * Daily send cap (beta: the provider's free plan, e.g. Resend 100/day). `limit` 0 turns it off. The last
 * `reserve` slots of the day are kept for essential mail — sign-in links, security and ops alerts,
 * invitations — so receipts and invoices can never lock merchants out of the dashboard.
 */
export interface DailyCap {
  readonly limit: number;
  readonly reserve: number;
}

const ESSENTIAL_PREFIXES = ["auth.", "security.", "ops.", "team."] as const;
/** Links that expire long before the next UTC day: refused at the cap instead of deferred. */
export const SHORT_LIVED_TEMPLATES: ReadonlySet<string> = new Set(["auth.magic_link", "ops.enrolment"]);
/** A capped message is retried on later days for at most this many days after it was queued. */
export const CAP_MAX_DEFER_DAYS = 3;

export const isEssential = (template: string): boolean => ESSENTIAL_PREFIXES.some((p) => template.startsWith(p));

/** Slots of the day a template may use: the whole cap for essential mail, the cap minus the reserve otherwise. */
export function dailyCeiling(cap: DailyCap, template: string): number {
  if (isEssential(template)) return cap.limit;
  return Math.max(0, cap.limit - Math.min(cap.reserve, cap.limit));
}

/** What to do with a message the cap refused: defer to the next UTC day, or fail it (expired or short-lived). */
export function cappedOutcome(template: string, queuedAt: Date, now: Date): "defer" | "fail" {
  if (SHORT_LIVED_TEMPLATES.has(template)) return "fail";
  return now.getTime() - queuedAt.getTime() >= CAP_MAX_DEFER_DAYS * 86_400_000 ? "fail" : "defer";
}

/** The UTC day (`YYYY-MM-DD`) of an instant. */
export const utcDay = (d: Date): string => d.toISOString().slice(0, 10);

/** When a deferred message runs again: the next UTC midnight plus up to 30 minutes of jitter. */
export function nextUtcDay(now: Date, random: () => number = Math.random): Date {
  const midnight = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
  return new Date(midnight + 60_000 + Math.floor(random() * 29 * 60_000));
}

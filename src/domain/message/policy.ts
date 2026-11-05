/**
 * Sending policy (lld/notify.md §6). Pure.
 *
 * - recipients are hashed with a keyed HMAC (suppressions and rate limits without storing addresses);
 * - a transient failure retries with backoff on the primary provider for 8 attempts, then moves to
 *   the fallback provider (Stage 5: SES) for 2 more; without a fallback the 8th failure is final;
 * - a permanent failure is final at once; a rejected recipient is also suppressed (hard bounce);
 * - at most `limit` sends per recipient per hour (magic-link abuse cannot mail-bomb an inbox).
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

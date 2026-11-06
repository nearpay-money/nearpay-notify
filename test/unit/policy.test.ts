import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  afterFailure,
  FALLBACK_ATTEMPTS,
  maxAttempts,
  normalizeAddress,
  overHourlyLimit,
  PRIMARY_ATTEMPTS,
  providerFor,
  recipientHash,
  recipientHashKey,
} from "../../src/domain/message/policy.js";
import { classifySmtpError } from "../../src/providers/smtp.js";

describe("recipient hashing", () => {
  const key = recipientHashKey(randomBytes(32));
  it("is case- and whitespace-insensitive, keyed and stable", () => {
    expect(normalizeAddress("  Alice@Example.COM ")).toBe("alice@example.com");
    expect(recipientHash(key, "Alice@Example.com").equals(recipientHash(key, " alice@example.com"))).toBe(true);
    expect(recipientHash(key, "alice@example.com").equals(recipientHash(key, "bob@example.com"))).toBe(false);
    const other = recipientHashKey(randomBytes(32));
    expect(recipientHash(key, "alice@example.com").equals(recipientHash(other, "alice@example.com"))).toBe(false);
    expect(recipientHash(key, "a@b.c")).toHaveLength(32);
  });
  it("derives the key deterministically from the KEK (and never returns the KEK)", () => {
    const kek = randomBytes(32);
    expect(recipientHashKey(kek).equals(recipientHashKey(kek))).toBe(true);
    expect(recipientHashKey(kek).equals(kek)).toBe(false);
  });
});

describe("attempts and providers", () => {
  it("primary for 8 attempts, then the fallback for 2 (if any)", () => {
    expect(PRIMARY_ATTEMPTS).toBe(8);
    expect(FALLBACK_ATTEMPTS).toBe(2);
    expect(providerFor(1, false)).toBe("primary");
    expect(providerFor(8, false)).toBe("primary");
    expect(providerFor(9, false)).toBeNull();
    expect(providerFor(9, true)).toBe("fallback");
    expect(providerFor(10, true)).toBe("fallback");
    expect(providerFor(11, true)).toBeNull();
    expect(maxAttempts(false)).toBe(8);
    expect(maxAttempts(true)).toBe(10);
  });
  it("permanent failures end at once; transient ones retry until the last attempt", () => {
    const transient = { permanent: false, recipientRejected: false, message: "timeout" };
    expect(afterFailure(transient, 1, false)).toEqual({ kind: "retry" });
    expect(afterFailure(transient, 7, false)).toEqual({ kind: "retry" });
    expect(afterFailure(transient, 8, false)).toEqual({ kind: "failed", suppress: false });
    expect(afterFailure(transient, 8, true)).toEqual({ kind: "retry" });
    expect(afterFailure(transient, 10, true)).toEqual({ kind: "failed", suppress: false });
    expect(afterFailure({ permanent: true, recipientRejected: false, message: "auth" }, 1, true)).toEqual({
      kind: "failed",
      suppress: false,
    });
    expect(afterFailure({ permanent: true, recipientRejected: true, message: "550" }, 1, true)).toEqual({
      kind: "failed",
      suppress: true,
    });
  });
  it("hourly limit", () => {
    expect(overHourlyLimit(19, 20)).toBe(false);
    expect(overHourlyLimit(20, 20)).toBe(true);
  });
});

describe("SMTP error classification", () => {
  it("5xx is permanent; 550/551/553 reject the recipient; 4xx and network errors are transient", () => {
    expect(classifySmtpError({ responseCode: 550, code: "EENVELOPE", message: "mailbox unavailable" })).toMatchObject({
      permanent: true,
      recipientRejected: true,
    });
    expect(classifySmtpError({ responseCode: 554, code: "EMESSAGE", message: "rejected" })).toMatchObject({
      permanent: true,
      recipientRejected: false,
    });
    expect(classifySmtpError({ responseCode: 421, code: "EPROTOCOL", message: "try later" })).toMatchObject({
      permanent: false,
    });
    expect(classifySmtpError({ code: "ECONNREFUSED", message: "connect ECONNREFUSED" })).toMatchObject({
      permanent: false,
    });
    expect(classifySmtpError({ code: "EENVELOPE", message: "No recipients defined" })).toMatchObject({
      permanent: true,
      recipientRejected: true,
    });
    expect(classifySmtpError(new Error("boom")).message).toBe("SMTP: boom");
    expect(classifySmtpError({ responseCode: 452, message: "x" }).message).toBe("SMTP 452: x");
  });
});

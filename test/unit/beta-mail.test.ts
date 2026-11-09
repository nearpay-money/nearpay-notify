/** Beta (public internet, Resend over SMTP): transport rules, error classes, daily cap policy, origin checks. */
import { describe, expect, it } from "vitest";
import { checkWorkerConfig } from "../../src/config.js";
import {
  CAP_MAX_DEFER_DAYS,
  cappedOutcome,
  dailyCeiling,
  isEssential,
  nextUtcDay,
  utcDay,
} from "../../src/domain/message/policy.js";
import { classifySmtpError, smtpTransportOptions, standardHeaders } from "../../src/providers/smtp.js";

const base = { timeoutMs: 5_000, domain: "nearpay.money" };

describe("SMTP transport options", () => {
  it("Resend: smtps on 465 with the user and the password from the secret file, verified TLS 1.2+", () => {
    const o = smtpTransportOptions({
      ...base,
      url: "smtps://smtp.resend.com:465",
      env: "server",
      user: "resend",
      password: "re_secret",
    });
    expect(o).toMatchObject({
      host: "smtp.resend.com",
      port: 465,
      secure: true,
      requireTLS: false,
      name: "nearpay.money",
      auth: { user: "resend", pass: "re_secret" },
      tls: { minVersion: "TLSv1.2", rejectUnauthorized: true, servername: "smtp.resend.com" },
    });
  });
  it("default ports: 465 for smtps, 587 for smtp; STARTTLS is required off local/test", () => {
    expect(smtpTransportOptions({ ...base, url: "smtps://smtp.resend.com", env: "server" }).port).toBe(465);
    const starttls = smtpTransportOptions({ ...base, url: "smtp://smtp.resend.com", env: "server" });
    expect(starttls).toMatchObject({ port: 587, secure: false, requireTLS: true });
    expect(smtpTransportOptions({ ...base, url: "smtp://mailpit:1025", env: "local" })).toMatchObject({
      port: 1025,
      requireTLS: false,
    });
    expect(smtpTransportOptions({ ...base, url: "smtp://mailpit:1025", env: "local" })).not.toHaveProperty("auth");
  });
  it("ignores URL query flags (no ignoreTLS / rejectUnauthorized=false through the URL)", () => {
    const o = smtpTransportOptions({
      ...base,
      url: "smtp://smtp.example.com:587?ignoreTLS=true&tls.rejectUnauthorized=false",
      env: "server",
    });
    expect(o).not.toHaveProperty("ignoreTLS");
    expect(o.tls).toMatchObject({ rejectUnauthorized: true });
  });
  it("a password in the URL: local/test only, never together with the secret file", () => {
    expect(smtpTransportOptions({ ...base, url: "smtp://u:p%40ss@mailpit:1025", env: "test" }).auth).toEqual({
      user: "u",
      pass: "p@ss",
    });
    expect(() => smtpTransportOptions({ ...base, url: "smtps://resend:key@smtp.resend.com", env: "server" })).toThrow(
      /must not carry a password/,
    );
    expect(() =>
      smtpTransportOptions({ ...base, url: "smtp://u:p@mailpit:1025", env: "test", user: "u", password: "q" }),
    ).toThrow(/use one of them/);
  });
  it("user and password come together", () => {
    expect(() => smtpTransportOptions({ ...base, url: "smtps://h", env: "server", password: "x" })).toThrow(
      /needs NP_SMTP_USER/,
    );
    expect(() => smtpTransportOptions({ ...base, url: "smtps://h", env: "server", user: "resend" })).toThrow(
      /needs NP_SMTP_PASSWORD_FILE/,
    );
    expect(() => smtpTransportOptions({ ...base, url: "http://h", env: "server" })).toThrow(/smtp/);
  });
  it("headers suppress auto-replies (no out-of-office loops) and mark the mail auto-generated", () => {
    expect(standardHeaders("m1")).toEqual({
      "Auto-Submitted": "auto-generated",
      "X-Auto-Response-Suppress": "All",
      "X-NearPay-Message": "m1",
    });
  });
});

describe("SMTP error classes never blame the recipient for a provider problem", () => {
  it("authentication failures are transient and never suppress", () => {
    expect(classifySmtpError({ code: "EAUTH", responseCode: 535, message: "Invalid login" })).toMatchObject({
      permanent: false,
      recipientRejected: false,
    });
    expect(classifySmtpError({ responseCode: 530, message: "Authentication required" })).toMatchObject({
      permanent: false,
    });
  });
  it("quota and rate-limit replies are transient whatever their code", () => {
    for (const message of ["550 5.7.1 Daily sending quota exceeded", "You have reached your daily limit", "rate limit"])
      expect(classifySmtpError({ responseCode: 550, code: "EMESSAGE", command: "DATA", message })).toMatchObject({
        permanent: false,
        recipientRejected: false,
      });
  });
  it("550 rejects the recipient only at the recipient stage", () => {
    expect(classifySmtpError({ responseCode: 550, command: "RCPT TO", message: "no such user" })).toMatchObject({
      permanent: true,
      recipientRejected: true,
    });
    expect(classifySmtpError({ responseCode: 550, command: "DATA", message: "domain not verified" })).toMatchObject({
      permanent: true,
      recipientRejected: false,
    });
    expect(classifySmtpError({ responseCode: 553, command: "MAIL FROM", message: "sender refused" })).toMatchObject({
      permanent: true,
      recipientRejected: false,
    });
  });
});

describe("daily cap policy", () => {
  it("essential mail may use the whole cap, the rest stops at cap − reserve", () => {
    for (const t of ["auth.magic_link", "security.recovery", "ops.kill_switch", "team.invitation"])
      expect(isEssential(t)).toBe(true);
    for (const t of ["payment.receipt", "invoice.issued", "account.welcome"]) expect(isEssential(t)).toBe(false);
    expect(dailyCeiling({ limit: 90, reserve: 10 }, "auth.magic_link")).toBe(90);
    expect(dailyCeiling({ limit: 90, reserve: 10 }, "payment.receipt")).toBe(80);
    expect(dailyCeiling({ limit: 5, reserve: 10 }, "payment.receipt")).toBe(0);
  });
  it("short-lived links fail at the cap; others defer for at most CAP_MAX_DEFER_DAYS", () => {
    const now = new Date("2026-11-09T20:00:00Z");
    expect(cappedOutcome("auth.magic_link", now, now)).toBe("fail");
    expect(cappedOutcome("ops.enrolment", now, now)).toBe("fail");
    expect(cappedOutcome("payment.receipt", new Date("2026-11-08T20:00:00Z"), now)).toBe("defer");
    const old = new Date(now.getTime() - CAP_MAX_DEFER_DAYS * 86_400_000);
    expect(cappedOutcome("payment.receipt", old, now)).toBe("fail");
  });
  it("deferred mail runs shortly after the next UTC midnight", () => {
    const now = new Date("2026-11-09T23:59:00Z");
    expect(utcDay(now)).toBe("2026-11-09");
    expect(nextUtcDay(now, () => 0).toISOString()).toBe("2026-11-10T00:01:00.000Z");
    expect(nextUtcDay(now, () => 0.999).getTime()).toBeLessThan(Date.parse("2026-11-10T00:30:00Z"));
    expect(nextUtcDay(new Date("2026-12-31T05:00:00Z"), () => 0).toISOString()).toBe("2027-01-01T00:01:00.000Z");
  });
});

describe("server-stage mail link origins", () => {
  const ok = {
    env: "server" as const,
    dashboardOrigin: "https://dashboard.nearpay.money",
    consoleOrigin: "https://ops.nearpay.money",
  };
  it("accepts public https origins and anything on local/test", () => {
    expect(checkWorkerConfig(ok)).toBe(ok);
    expect(() =>
      checkWorkerConfig({ ...ok, env: "local", dashboardOrigin: "https://dashboard.nearpay.localhost" }),
    ).not.toThrow();
  });
  it("refuses localhost defaults and http on the server stage", () => {
    expect(() => checkWorkerConfig({ ...ok, dashboardOrigin: "https://dashboard.nearpay.localhost" })).toThrow(
      /NP_DASHBOARD_ORIGIN/,
    );
    expect(() => checkWorkerConfig({ ...ok, consoleOrigin: "http://ops.nearpay.money" })).toThrow(/NP_CONSOLE_ORIGIN/);
  });
});

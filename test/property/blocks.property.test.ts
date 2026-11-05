import { randomBytes } from "node:crypto";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  afterFailure,
  maxAttempts,
  providerFor,
  recipientHash,
  recipientHashKey,
} from "../../src/domain/message/policy.js";
import { escapeHtml, safeSubject } from "../../src/domain/template/blocks.js";

const unescapeHtml = (s: string) =>
  s
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&amp;", "&");

describe("escaping properties", () => {
  it("escaped text has no markup characters and round-trips", () => {
    fc.assert(
      fc.property(fc.string({ unit: "binary" }), (s) => {
        const e = escapeHtml(s);
        expect(e).not.toMatch(/[<>"']/);
        expect(unescapeHtml(e)).toBe(s);
      }),
    );
  });
  it("subjects never contain line breaks and stay bounded", () => {
    fc.assert(
      fc.property(fc.string({ unit: "binary" }), (s) => {
        const out = safeSubject(s);
        expect(out).not.toMatch(/[\r\n]/);
        expect(out.length).toBeLessThanOrEqual(200);
      }),
    );
  });
});

describe("sending policy properties", () => {
  const key = recipientHashKey(randomBytes(32));
  it("recipient hashes ignore case and surrounding space", () => {
    fc.assert(
      fc.property(fc.emailAddress(), fc.boolean(), (a, upper) => {
        const b = ` ${upper ? a.toUpperCase() : a} `;
        expect(recipientHash(key, a).equals(recipientHash(key, b))).toBe(true);
      }),
    );
  });
  it("a permanent failure never retries; a transient one retries exactly while attempts remain", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 12 }),
        fc.boolean(),
        fc.boolean(),
        fc.boolean(),
        (attempt, permanent, rejected, fb) => {
          const o = afterFailure({ permanent, recipientRejected: rejected, message: "x" }, attempt, fb);
          if (permanent) expect(o).toEqual({ kind: "failed", suppress: rejected });
          else expect(o.kind === "retry").toBe(attempt < maxAttempts(fb));
          // every retry has a provider for the next attempt
          if (o.kind === "retry") expect(providerFor(attempt + 1, fb)).not.toBeNull();
        },
      ),
    );
  });
});

import { randomBytes } from "node:crypto";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { chooseRecipients, lookupEmails } from "../../src/domain/message/audience.js";
import {
  afterFailure,
  maxAttempts,
  providerFor,
  recipientHash,
  recipientHashKey,
} from "../../src/domain/message/policy.js";
import { contentMjml, contentText, escapeHtml, safeSubject } from "../../src/domain/template/blocks.js";
import { formatDuration } from "../../src/domain/template/catalogue.js";

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

describe("audience properties", () => {
  const ROLES = ["owner", "admin", "developer", "finance", "support", "viewer"] as const;
  const recipient = fc.record({
    user_id: fc.constantFrom("usr_a", "usr_b", "usr_c", "usr_d", "usr_e"),
    email: fc.emailAddress(),
    role: fc.constantFrom(...ROLES),
  });
  it("chosen recipients come from the list, match the roles, skip excluded users and are unique", () => {
    fc.assert(
      fc.property(
        fc.array(recipient, { maxLength: 12 }),
        fc.option(fc.subarray([...ROLES], { minLength: 1 }), { nil: undefined }),
        fc.subarray(["usr_a", "usr_b", "usr_c", "usr_d", "usr_e"]),
        (list, roles, exclude) => {
          const chosen = chooseRecipients(list, { roles, exclude });
          const ids = chosen.map((r) => r.user_id);
          expect(new Set(ids).size).toBe(ids.length); // one message per user: dedupe keys never collide
          for (const r of chosen) {
            expect(list).toContain(r);
            expect(exclude).not.toContain(r.user_id);
            if (roles) expect(roles).toContain(r.role);
          }
          // nobody eligible is dropped
          const eligible = new Set(
            list
              .filter((r) => !exclude.includes(r.user_id) && (!roles || (roles as string[]).includes(r.role)))
              .map((r) => r.user_id),
          );
          expect(new Set(ids)).toEqual(eligible);
        },
      ),
    );
  });
  it("looked-up emails are a listed user's email or null, never another user's", () => {
    fc.assert(
      fc.property(
        fc.array(recipient, { maxLength: 8 }),
        fc.option(fc.constantFrom("usr_a", "usr_b", "usr_z"), { nil: null }),
        (list, id) => {
          const { member_email } = lookupEmails(list, { member_email: id });
          if (id === null || !list.some((r) => r.user_id === id)) expect(member_email).toBeNull();
          else expect(list.find((r) => r.user_id === id)?.email).toBe(member_email);
        },
      ),
    );
  });
});

describe("template properties", () => {
  it("callouts escape any text in the HTML part and keep it verbatim in the text part", () => {
    fc.assert(
      fc.property(fc.string({ minLength: 1 }), fc.constantFrom("info" as const, "warning" as const), (t, tone) => {
        const c = { subject: "s", preheader: "p", heading: "h", blocks: [{ kind: "callout" as const, tone, text: t }] };
        const html = contentMjml(c);
        expect(html).toContain(escapeHtml(t));
        expect(contentText(c, "f")).toContain(t);
      }),
    );
  });
  it("durations always render as a positive whole number of one unit", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 10_080 }), (m) => {
        const [n, unit] = formatDuration(m).split(" ");
        const factor = { minute: 1, minutes: 1, hour: 60, hours: 60, day: 1440, days: 1440 }[unit as string];
        expect(factor).toBeDefined();
        expect(Number(n) * (factor as number)).toBe(m);
      }),
    );
  });
});

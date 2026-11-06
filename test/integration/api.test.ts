/** `POST /internal/messages` (lld/notify.md §5): queueing, dedupe, encryption at rest, auth. */
import { sql } from "@nearpay-internal/db";
import { toUuid } from "@nearpay-internal/ids";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { recipientHash } from "../../src/domain/message/policy.js";
import { mintServiceToken, type Stack, startStack } from "../support/stack.js";

let s: Stack;
beforeAll(async () => {
  s = await startStack();
});
afterAll(async () => {
  await s?.stop();
});

const magic = (over: Record<string, unknown> = {}) => ({
  template: "auth.magic_link",
  to: "Alice@Example.com",
  variables: {
    link_url: "https://dashboard.nearpay.localhost/auth/magic?token=t1",
    purpose: "signup",
    expires_in_minutes: 15,
  },
  dedupe_key: `signup:${Math.random()}`,
  ...over,
});

describe("POST /internal/messages", () => {
  it("queues a magic link: 202 msg_, one message and one send job", async () => {
    const body = magic();
    const r = await s.call("POST", "/internal/messages", { body });
    expect(r.status).toBe(202);
    const id = (r.body as { message_id: string }).message_id;
    expect(id).toMatch(/^msg_/);
    const row = await s.admin.db
      .selectFrom("messages")
      .selectAll()
      .where("id", "=", toUuid(id, "msg"))
      .executeTakeFirstOrThrow();
    expect(row).toMatchObject({
      template: "auth.magic_link",
      locale: "en",
      status: "queued",
      source: "api",
      attempts: 0,
    });
    expect(row.dedupe_key).toBe(`auth.magic_link:${body.dedupe_key}`);
    expect(row.to_hash.equals(recipientHash(s.notify.hashKey, "alice@example.com"))).toBe(true);
    // PII at rest is encrypted: neither the address nor the link appear in the row
    expect(row.to_enc.includes(Buffer.from("Alice@Example.com"))).toBe(false);
    expect(row.variables_enc.includes(Buffer.from("token=t1"))).toBe(false);
    expect(s.notify.cipher.decrypt(row.to_enc, `msg:${row.id}:to`).toString()).toBe("Alice@Example.com");
    const jobs = await sql<{ kind: string; max_attempts: number }>`
      select kind, max_attempts from jobs where dedupe_key = ${`message.send:${row.id}`}`.execute(s.admin.db);
    expect(jobs.rows).toEqual([{ kind: "message.send", max_attempts: 10 }]);
  });

  it("the same dedupe key returns the same message (repeated requests send once)", async () => {
    const body = magic({ dedupe_key: "login:usr_1:attempt-1" });
    const a = await s.call("POST", "/internal/messages", { body });
    const b = await s.call("POST", "/internal/messages", { body: { ...body, to: "other@example.com" } });
    expect(b.body).toEqual(a.body);
    const n = await s.admin.db
      .selectFrom("messages")
      .select("id")
      .where("dedupe_key", "=", "auth.magic_link:login:usr_1:attempt-1")
      .execute();
    expect(n).toHaveLength(1);
  });

  it("falls back to English for unknown locales", async () => {
    const r = await s.call("POST", "/internal/messages", { body: magic({ locale: "de-DE" }) });
    const row = await s.admin.db
      .selectFrom("messages")
      .select("locale")
      .where("id", "=", toUuid((r.body as { message_id: string }).message_id, "msg"))
      .executeTakeFirstOrThrow();
    expect(row.locale).toBe("en");
  });

  it("rejects invalid requests with the spec error envelope", async () => {
    const badLink = await s.call("POST", "/internal/messages", {
      body: magic({ variables: { link_url: "javascript:alert(1)", purpose: "signup", expires_in_minutes: 15 } }),
    });
    expect(badLink.status).toBe(400);
    expect(badLink.body).toMatchObject({ error: { code: "invalid_request" } });
    const otherTemplate = await s.call("POST", "/internal/messages", { body: magic({ template: "payment.receipt" }) });
    expect(otherTemplate.status).toBe(400);
    const badTo = await s.call("POST", "/internal/messages", { body: magic({ to: "not an email" }) });
    expect(badTo.body).toMatchObject({ error: { code: "invalid_request", param: "to" } });
  });

  it("requires notify.send (identity and billing hold it)", async () => {
    expect(
      (await s.call("POST", "/internal/messages", { body: magic(), token: await mintServiceToken("billing") })).status,
    ).toBe(202);
    expect(
      (await s.call("POST", "/internal/messages", { body: magic(), token: await mintServiceToken("payments") })).status,
    ).toBe(403);
    expect((await s.call("POST", "/internal/messages", { body: magic(), token: "" })).status).toBe(401);
  });

  it("the app role cannot change the schema", async () => {
    await expect(sql`create table nope (id int)`.execute(s.admin.db)).rejects.toThrow(/permission denied/);
  });
});

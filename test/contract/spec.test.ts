/**
 * Contract (foundations §16): every Stage-1 notify route is bound, every subject the catalogue
 * routes to notify has a handler, responses and errors have the spec's shapes, and the peer routes
 * notify calls exist with the scopes notify holds (the mocks in the worker tests enforce the rest).
 */
import { ErrorEnvelope, PUBLIC_ROUTES, SERVICE_CLIENT_SCOPES } from "@nearpay/spec";
import { unhandledSubjects } from "@nearpay-internal/bus";
import { unimplementedRoutes } from "@nearpay-internal/service";
import {
  getNotificationRecipients,
  getReceiptContext,
  INTERNAL_ROUTES,
  SUBJECTS,
  type Subject,
  sendMessage,
} from "@nearpay-internal/spec";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { notifyRoutes } from "../../src/api/routes.js";
import { notifyHandlers } from "../../src/consumers/handlers.js";
import { type Stack, startStack } from "../support/stack.js";

let s: Stack;
beforeAll(async () => {
  s = await startStack();
});
afterAll(async () => {
  await s?.stop();
});

const ALL = [...PUBLIC_ROUTES, ...INTERNAL_ROUTES];

describe("routes", () => {
  it("binds every Stage-1 notify route, and nothing else", () => {
    const bindings = notifyRoutes({} as never);
    expect(unimplementedRoutes("notify", ALL, bindings).map((r) => r.id)).toEqual([]);
    expect(bindings.map((b) => b.route.id)).toEqual(
      ALL.filter((r) => r.service === "notify" && r.stage <= 1).map((r) => r.id),
    );
  });

  it("responses and errors match the spec", async () => {
    const ok = await s.call("POST", "/internal/messages", {
      body: {
        template: "auth.magic_link",
        to: "contract@example.test",
        variables: {
          link_url: "https://dashboard.nearpay.localhost/m?t=1",
          purpose: "recovery",
          expires_in_minutes: 10,
        },
        dedupe_key: "contract-1",
      },
    });
    expect(ok.status).toBe(sendMessage.status);
    expect(sendMessage.response.safeParse(ok.body).success).toBe(true);
    for (const r of [
      await s.call("POST", "/internal/messages", { body: { template: "nope" } }),
      await s.call("POST", "/internal/messages", { body: {}, token: "" }),
    ])
      expect(ErrorEnvelope.safeParse(r.body).success, JSON.stringify(r.body)).toBe(true);
  });

  it("the peer routes notify calls are authorized for notify's service scopes", () => {
    for (const route of [getNotificationRecipients, getReceiptContext]) {
      const scopes = route.auth.filter((a) => a.startsWith("service:")).map((a) => a.slice("service:".length));
      expect(
        scopes.some((sc) => (SERVICE_CLIENT_SCOPES.notify as readonly string[]).includes(sc)),
        route.id,
      ).toBe(true);
    }
  });
});

describe("events", () => {
  it("handles every subject the catalogue routes to notify", () => {
    const handlers = notifyHandlers({} as never, {} as never);
    expect(unhandledSubjects("notify", handlers)).toEqual([]);
    for (const subject of Object.keys(handlers) as Subject[]) expect(SUBJECTS[subject].consumers).toContain("notify");
  });
  it("notify produces no events (so it runs no outbox relay)", () => {
    expect((Object.keys(SUBJECTS) as Subject[]).filter((k) => SUBJECTS[k].producer === "notify")).toEqual([]);
  });
});

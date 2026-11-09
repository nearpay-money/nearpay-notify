/**
 * Contract (foundations §16): every notify route is bound (incl. the Stage 2 API templates), every subject the catalogue
 * routes to notify has a handler, responses and errors have the spec's shapes, and the peer routes
 * notify calls exist with the scopes notify holds (the mocks in the worker tests enforce the rest).
 */
import { ErrorEnvelope, PUBLIC_ROUTES, SERVICE_CLIENT_SCOPES } from "@nearpay/spec";
import { unhandledSubjects } from "@nearpay-internal/bus";
import { unimplementedRoutes } from "@nearpay-internal/service";
import {
  BILLING_EMAIL_TEMPLATES,
  getInvoiceNotificationContext,
  getMandateNotificationContext,
  getNotificationRecipients,
  getReceiptContext,
  getRefundReceiptContext,
  getSubscriptionNotificationContext,
  INTERNAL_ROUTES,
  SUBJECTS,
  type Subject,
  sendMessage,
} from "@nearpay-internal/spec";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { notifyRoutes } from "../../src/api/routes.js";
import { notifyHandlers } from "../../src/consumers/handlers.js";
import { isTemplate, type TemplateName } from "../../src/domain/template/catalogue.js";
import { SAMPLES } from "../../src/domain/template/samples.js";
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
  it("binds every notify route (Stage 1 and 2), and nothing else", () => {
    const bindings = notifyRoutes({} as never);
    expect(unimplementedRoutes("notify", ALL, bindings).map((r) => r.id)).toEqual([]);
    expect(bindings.map((b) => b.route.id)).toEqual(
      ALL.filter((r) => r.service === "notify" && r.stage <= 2).map((r) => r.id),
    );
  });

  it("every template the API accepts has a catalogue entry and samples", () => {
    const options = (sendMessage.body as unknown as { options: { shape: { template: { value: string } } }[] }).options;
    const templates = options.map((o) => o.shape.template.value).sort();
    expect(templates).toEqual(["auth.magic_link", "ops.enrolment", "team.invitation"]);
    for (const t of templates) {
      expect(isTemplate(t), t).toBe(true);
      expect(SAMPLES[t as TemplateName].length, t).toBeGreaterThan(0);
    }
  });

  it("the API's variables for each template are accepted by the catalogue", async () => {
    for (const body of [
      {
        template: "team.invitation",
        to: "invitee@example.test",
        variables: {
          link_url: "https://dashboard.nearpay.localhost/auth/invite#token=t",
          account_display_name: "Acme",
          role: "viewer",
          expires_in_minutes: 10_080,
        },
        dedupe_key: "inv-contract-1",
      },
      {
        template: "ops.enrolment",
        to: "op@example.test",
        variables: {
          link_url: "https://ops.nearpay.localhost/auth/enrol#token=t",
          role: "ops",
          expires_in_minutes: 1440,
        },
        dedupe_key: "enrol-contract-1",
      },
    ]) {
      const r = await s.call("POST", "/internal/messages", { body });
      expect(r.status, JSON.stringify(r.body)).toBe(202);
      expect(sendMessage.response.safeParse(r.body).success).toBe(true);
    }
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
    for (const route of [
      getNotificationRecipients,
      getReceiptContext,
      getRefundReceiptContext,
      getInvoiceNotificationContext,
      getSubscriptionNotificationContext,
      getMandateNotificationContext,
    ]) {
      const scopes = route.auth.filter((a) => a.startsWith("service:")).map((a) => a.slice("service:".length));
      expect(
        scopes.some((sc) => (SERVICE_CLIENT_SCOPES.notify as readonly string[]).includes(sc)),
        route.id,
      ).toBe(true);
    }
  });
});

describe("billing emails (spec BILLING_EMAIL_TEMPLATES)", () => {
  it("every billing template has a catalogue entry, samples, a consumed subject and a context route notify may call", () => {
    const routes = new Map(INTERNAL_ROUTES.map((r) => [r.id, r]));
    for (const [template, { subject, context }] of Object.entries(BILLING_EMAIL_TEMPLATES)) {
      expect(isTemplate(template), template).toBe(true);
      expect(SAMPLES[template as TemplateName].length, template).toBeGreaterThan(0);
      expect(SUBJECTS[subject as Subject].consumers, subject).toContain("notify");
      expect(routes.get(context)?.service, context).toBe("billing");
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

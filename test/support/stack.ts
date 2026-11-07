/**
 * Integration harness: Postgres (migrator/app roles like nearpay-deploy), NATS JetStream, a real
 * Mailpit SMTP sink, and spec-generated mocks of identity and payments (recipient resolution). The
 * `api` and `worker` are built by the same factories `main.ts` uses.
 */
import { randomBytes } from "node:crypto";
import { type Bus, connectBus, type Envelope, publish } from "@nearpay-internal/bus";
import { createDb, type Database, migrate } from "@nearpay-internal/db";
import type { Service } from "@nearpay-internal/service";
import { INTERNAL_ROUTES } from "@nearpay-internal/spec";
import {
  type MockPeer,
  mintServiceToken,
  mockPeer,
  provisionServiceDatabase,
  type Started,
  startNats,
  startPostgres,
  testKeySource,
  testServiceToken,
} from "@nearpay-internal/testing";
import { GenericContainer, type StartedTestContainer, Wait } from "testcontainers";
import type { Notify } from "../../src/app/context.js";
import { createApi, createWorker } from "../../src/app/services.js";
import type { ApiConfig, WorkerConfig } from "../../src/config.js";
import { httpPeers } from "../../src/infra/clients/peers.js";
import { MIGRATIONS_DIR } from "../../src/infra/db/migrations.js";
import type { DB } from "../../src/infra/db/schema.js";
import type { EmailProvider } from "../../src/providers/provider.js";

export interface MailpitMessage {
  ID: string;
  MessageID: string;
  Subject: string;
  From: { Address: string; Name: string };
  To: { Address: string; Name: string }[];
}

export interface Mailpit {
  readonly smtpUrl: string;
  readonly apiUrl: string;
  messages(): Promise<MailpitMessage[]>;
  message(id: string): Promise<{ Text: string; HTML: string; Subject: string }>;
  headers(id: string): Promise<Record<string, string[]>>;
  clear(): Promise<void>;
  /** Waits until `n` messages match. */
  waitFor(match: (m: MailpitMessage) => boolean, n?: number, timeoutMs?: number): Promise<MailpitMessage[]>;
}

async function startMailpit(): Promise<{ container: StartedTestContainer; mailpit: Mailpit }> {
  const container = await new GenericContainer("axllent/mailpit:v1.27.11")
    .withEnvironment({ MP_SMTP_AUTH_ACCEPT_ANY: "1", MP_SMTP_AUTH_ALLOW_INSECURE: "1" })
    .withExposedPorts(1025, 8025)
    .withWaitStrategy(Wait.forHttp("/readyz", 8025).forStatusCode(200))
    .withStartupTimeout(60_000)
    .start();
  const apiUrl = `http://${container.getHost()}:${container.getMappedPort(8025)}`;
  const get = async (path: string) => (await fetch(`${apiUrl}${path}`)).json();
  const mailpit: Mailpit = {
    smtpUrl: `smtp://${container.getHost()}:${container.getMappedPort(1025)}`,
    apiUrl,
    async messages() {
      return ((await get("/api/v1/messages?limit=500")) as { messages: MailpitMessage[] }).messages;
    },
    async message(id) {
      return (await get(`/api/v1/message/${id}`)) as { Text: string; HTML: string; Subject: string };
    },
    async headers(id) {
      return (await get(`/api/v1/message/${id}/headers`)) as Record<string, string[]>;
    },
    async clear() {
      await fetch(`${apiUrl}/api/v1/messages`, { method: "DELETE" });
    },
    async waitFor(match, n = 1, timeoutMs = 15_000) {
      const until = Date.now() + timeoutMs;
      for (;;) {
        const hits = (await mailpit.messages()).filter(match);
        if (hits.length >= n) return hits;
        if (Date.now() > until)
          throw new Error(`expected ${n} matching message(s) within ${timeoutMs} ms, got ${hits.length}`);
        await new Promise((r) => setTimeout(r, 100));
      }
    },
  };
  return { container, mailpit };
}

export interface Stack {
  readonly pg: Started;
  readonly admin: Database<DB>;
  readonly api: Service;
  readonly notify: Notify;
  readonly worker: { service: Service; notify: Notify; metricsPort: number } | null;
  readonly identity: MockPeer;
  readonly payments: MockPeer;
  readonly mailpit: Mailpit;
  readonly bus: Bus | null;
  readonly kek: string;
  call(
    method: "POST" | "GET",
    url: string,
    o?: { body?: unknown; token?: string },
  ): Promise<{ status: number; body: unknown }>;
  publishEvent(e: Envelope): Promise<void>;
  stop(): Promise<void>;
}

export interface StackOptions {
  worker?: boolean;
  testModeReceipts?: boolean;
  securityContacts?: string[];
  provider?: EmailProvider;
  fallback?: EmailProvider;
  hourlyLimit?: number;
}

export async function startStack(o: StackOptions = {}): Promise<Stack> {
  const [pg, nats, mp] = await Promise.all([
    startPostgres({ database: "postgres" }),
    o.worker ? startNats() : Promise.resolve(null),
    startMailpit(),
  ]);
  const { migratorUrl, appUrl } = await provisionServiceDatabase(pg.url, "notify");
  const migrator = createDb<DB>({ url: migratorUrl });
  await migrate(migrator.db, MIGRATIONS_DIR);
  await migrator.close();

  const [identity, payments] = await Promise.all([
    mockPeer({ service: "identity", routes: INTERNAL_ROUTES }),
    mockPeer({ service: "payments", routes: INTERNAL_ROUTES }),
  ]);
  const kek = randomBytes(32).toString("base64");
  const admin = createDb<DB>({ url: appUrl, applicationName: "notify-test" });
  const base = {
    env: "test" as const,
    logLevel: "silent" as const,
    host: "127.0.0.1",
    port: 0,
    metricsPort: 0,
    dbUrl: appUrl,
    piiKek: kek,
  };

  const apiDb = createDb<DB>({ url: appUrl, applicationName: "notify-api-test" });
  const apiConfig: ApiConfig = base;
  const { service: api, notify } = createApi(apiConfig, { keys: testKeySource(), database: apiDb });
  await api.start();

  let worker: Stack["worker"] = null;
  let bus: Bus | null = null;
  let workerDb: Database<DB> | null = null;
  if (o.worker && nats) {
    bus = await connectBus({ url: nats.url, name: "notify-test-publisher" });
    workerDb = createDb<DB>({ url: appUrl, applicationName: "notify-worker-test" });
    const config: WorkerConfig = {
      ...base,
      natsUrl: nats.url,
      emailProvider: "smtp",
      smtpUrl: mp.mailpit.smtpUrl,
      from: "NearPay <no-reply@nearpay.money>",
      securityContacts: o.securityContacts ?? ["ops@nearpay.test"],
      testModeReceipts: o.testModeReceipts ?? false,
      dashboardOrigin: "https://dashboard.nearpay.localhost",
      consoleOrigin: "https://ops.nearpay.localhost",
      identityUrl: identity.url,
      paymentsUrl: payments.url,
      serviceClientSecret: "unused-in-tests",
      sendTimeoutMs: 5_000,
      messageRetentionDays: 90,
      recipientHourlyLimit: o.hourlyLimit ?? 20,
    };
    const w = await createWorker(config, {
      database: workerDb,
      tickMs: 50,
      peers: httpPeers({
        identityUrl: identity.url,
        paymentsUrl: payments.url,
        serviceToken: testServiceToken("notify"),
      }),
      ...(o.provider ? { provider: o.provider } : {}),
      ...(o.fallback ? { fallback: o.fallback } : {}),
    });
    const { metricsPort } = await w.service.start();
    worker = { ...w, metricsPort };
  }

  return {
    pg,
    admin,
    api,
    notify,
    worker,
    identity,
    payments,
    mailpit: mp.mailpit,
    bus,
    kek,
    async call(method, url, opts = {}) {
      const token = opts.token ?? (await mintServiceToken("identity"));
      const r = await api.app.inject({
        method,
        url,
        ...(opts.body !== undefined ? { payload: opts.body as object } : {}),
        headers: token === "" ? {} : { "x-nearpay-token": token },
      });
      return { status: r.statusCode, body: r.body ? JSON.parse(r.body) : undefined };
    },
    async publishEvent(e) {
      if (!bus) throw new Error("the stack runs without NATS");
      await publish(bus, e.subject, e);
    },
    async stop() {
      await worker?.service.stop();
      await api.stop();
      await bus?.close();
      await workerDb?.close();
      await apiDb.close();
      await admin.close();
      await Promise.all([identity.stop(), payments.stop()]);
      await Promise.all([pg.stop(), nats?.stop(), mp.container.stop()]);
    },
  };
}

export async function eventually<T>(fn: () => Promise<T | null | undefined | false>, timeoutMs = 15_000): Promise<T> {
  const until = Date.now() + timeoutMs;
  let last: unknown;
  for (;;) {
    try {
      const v = await fn();
      if (v !== null && v !== undefined && v !== false) return v as T;
    } catch (e) {
      last = e;
    }
    if (Date.now() > until)
      throw new Error(`condition not met within ${timeoutMs} ms${last ? `: ${String(last)}` : ""}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

export { mintServiceToken };

/**
 * Process wiring (lld/notify.md §2): `api` serves `POST /internal/messages` (2 replicas: login
 * links depend on it); `worker` runs the consumers, the job worker (fan-out and sends) and the
 * recurring purges. Notify produces no domain events, so it runs no outbox relay.
 */
import { hostname } from "node:os";
import type { KeySource } from "@nearpay-internal/auth";
import { type Bus, busReady, connectBus, consumerLag, domainConsumersTask, durablesOf } from "@nearpay-internal/bus";
import { destinationFingerprint, getChain, normalizeAddress } from "@nearpay-internal/chains";
import {
  createDb,
  createEnvelopeCipher,
  type Database,
  deadLettersOpen,
  jobsDue,
  jobWorkerTask,
  migrationStatus,
  parseKek,
  recurringJobsTask,
  sql,
} from "@nearpay-internal/db";
import { createService, type Service } from "@nearpay-internal/service";
import type { Subject } from "@nearpay-internal/spec";
import { notifyRoutes } from "../api/routes.js";
import type { ApiConfig, WorkerConfig } from "../config.js";
import { deadLetters, notifyHandlers } from "../consumers/handlers.js";
import { recipientHashKey } from "../domain/message/policy.js";
import type { RoutingOptions } from "../domain/message/routing.js";
import { TEMPLATE_NAMES } from "../domain/template/catalogue.js";
import { SAMPLES } from "../domain/template/samples.js";
import { httpPeers, notifyServiceToken, type Peers } from "../infra/clients/peers.js";
import { MIGRATIONS_DIR } from "../infra/db/migrations.js";
import type { DB } from "../infra/db/schema.js";
import type { EmailProvider } from "../providers/provider.js";
import { smtpProvider } from "../providers/smtp.js";
import { jobHandlers, RECURRING } from "../workers/jobs.js";
import { type Notify, notifyMetrics } from "./context.js";
import { createRenderer, type Renderer } from "./render.js";

export interface ServiceDeps {
  keys?: KeySource;
  database?: Database<DB>;
}

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

/** The bootstrap creates the logger and metrics, so they are attached right after the service exists. */
function context(database: Database<DB>, kek: string): Mutable<Notify> {
  const key = parseKek(kek);
  return {
    db: database.db,
    cipher: createEnvelopeCipher(key),
    hashKey: recipientHashKey(key),
    log: undefined as unknown as Notify["log"],
    metrics: undefined as unknown as Notify["metrics"],
  };
}

function attach(n: Mutable<Notify>, service: Service): Notify {
  n.log = service.log;
  n.metrics = notifyMetrics(service.metrics);
  return n;
}

function readiness(database: Database<DB>) {
  return {
    db: () => sql`select 1`.execute(database.db),
    migrations: async () => {
      const s = await migrationStatus(database.db, MIGRATIONS_DIR);
      if (s.pending.length || s.drift.length)
        throw new Error(`pending ${s.pending.join(",") || "-"} drift ${s.drift.join(",") || "-"}`);
    },
  };
}

/** Renders every template sample (fails fast on a broken layout or template, e.g. a missing file in the image). */
export async function selfCheck(render: Renderer): Promise<number> {
  let n = 0;
  for (const t of TEMPLATE_NAMES)
    for (const v of SAMPLES[t]) {
      await render(t, v, "en");
      n++;
    }
  return n;
}

export function createApi(config: ApiConfig, deps: ServiceDeps = {}): { service: Service; notify: Notify } {
  const database = deps.database ?? createDb<DB>({ url: config.dbUrl, applicationName: "notify-api" });
  const n = context(database, config.piiKek);
  const service = createService({
    name: "notify",
    config,
    ...(deps.keys ? { keys: deps.keys } : {}),
    routes: notifyRoutes(n),
    readiness: readiness(database),
  });
  attach(n, service);
  if (!deps.database) service.onShutdown(() => database.close());
  return { service, notify: n };
}

export interface WorkerDeps extends ServiceDeps {
  bus?: Bus;
  peers?: Peers;
  provider?: EmailProvider;
  fallback?: EmailProvider;
  tickMs?: number;
}

export async function createWorker(
  config: WorkerConfig,
  deps: WorkerDeps = {},
): Promise<{ service: Service; notify: Notify }> {
  const database = deps.database ?? createDb<DB>({ url: config.dbUrl, applicationName: "notify-worker" });
  const render = createRenderer();
  const rendered = await selfCheck(render);
  const service = createService({ name: "notify", config, readiness: readiness(database) });
  const n = attach(context(database, config.piiKek), service);
  n.log.info({ samples: rendered }, "templates rendered (self-check)");

  const routing: RoutingOptions = {
    dashboardOrigin: config.dashboardOrigin,
    consoleOrigin: config.consoleOrigin,
    testModeReceipts: config.testModeReceipts,
    chainName: (caip2) => getChain(caip2)?.name ?? caip2,
    fingerprint: (caip2, address, assetId) => {
      try {
        return destinationFingerprint(caip2, normalizeAddress(caip2, address), assetId);
      } catch {
        return null;
      }
    },
  };
  const peers =
    deps.peers ??
    httpPeers({
      identityUrl: config.identityUrl,
      paymentsUrl: config.paymentsUrl,
      serviceToken: notifyServiceToken(config.identityUrl, config.serviceClientSecret),
    });
  const domain = /@([^>]+)>$/.exec(config.from)?.[1] ?? "nearpay.money";
  const primary = deps.provider ?? smtpProvider({ url: config.smtpUrl, timeoutMs: config.sendTimeoutMs, domain });

  const bus = deps.bus ?? (await connectBus({ url: config.natsUrl, name: `notify-worker@${hostname()}` }));
  service.addReadiness("bus", () => {
    if (!busReady(bus)) throw new Error("NATS connection is closed");
  });
  const handlers = notifyHandlers(database.db, routing);
  const durables = durablesOf("notify", Object.keys(handlers) as Subject[]);
  service.metrics.collectConsumerLag(async () =>
    Object.fromEntries(
      await Promise.all(durables.map(async (d) => [d.durable, await consumerLag(bus, d.stream, d.durable)])),
    ),
  );
  service.metrics.collectJobsDue(() => jobsDue(database.db));
  service.metrics.collectDeadLettersOpen(() => deadLettersOpen(database.db));
  service.metrics.gauge("messages_queued", "Messages waiting to be sent.", [], async (g) => {
    const r = await sql<{ n: string }>`select count(*)::text as n from messages where status = 'queued'`.execute(
      database.db,
    );
    g.set(Number(r.rows[0]?.n ?? 0));
  });

  const onError = (e: unknown) => service.log.error({ err: e }, "background error");
  service.addBackground(
    domainConsumersTask({ bus, consumer: "notify", handlers, onDeadLetter: deadLetters(database.db), onError }),
  );
  service.addBackground(
    jobWorkerTask({
      db: database.db,
      workerId: `notify-worker@${hostname()}:${process.pid}`,
      handlers: jobHandlers(
        { n, peers, routing, securityContacts: config.securityContacts },
        {
          n,
          render,
          primary,
          ...(deps.fallback ? { fallback: deps.fallback } : {}),
          from: config.from,
          hourlyLimit: config.recipientHourlyLimit,
        },
        { retentionDays: config.messageRetentionDays },
      ),
      onError: (e, job) => service.log.warn({ err: e, job }, "job failed"),
      onDeadLetter: (j) => service.log.error({ job: j }, "job dead-lettered"),
      ...(deps.tickMs ? { pollMs: deps.tickMs } : {}),
    }),
  );
  service.addBackground(
    recurringJobsTask({
      db: database.db,
      pool: database.pool,
      name: "notify:recurring-jobs",
      jobs: RECURRING,
      onError,
      ...(deps.tickMs ? { tickMs: deps.tickMs } : {}),
    }),
  );
  service.onShutdown(async () => {
    await primary.close?.();
    await deps.fallback?.close?.();
    if (!deps.bus) await bus.close();
    if (!deps.database) await database.close();
  });
  return { service, notify: n };
}

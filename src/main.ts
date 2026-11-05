/**
 * Process entry (foundations §15, lld/notify.md §2): `node dist/main.js api|worker|migrate|healthcheck`.
 * - `api`      `POST /internal/messages` (magic links from identity)
 * - `worker`   domain consumers, fan-out and send jobs, purges
 * - `migrate`  applies kit + notify migrations with the migrator role (one-shot)
 */
import { createDb, migrate } from "@nearpay-internal/db";
import { loadConfig, runMain } from "@nearpay-internal/service";
import { migrateShape, readApiConfig, readWorkerConfig } from "./config.js";
import { MIGRATIONS_DIR } from "./infra/db/migrations.js";

await runMain({
  api: async () => {
    const { createApi } = await import("./app/services.js");
    return createApi(readApiConfig()).service;
  },
  worker: async () => {
    const { createWorker } = await import("./app/services.js");
    return (await createWorker(readWorkerConfig())).service;
  },
  migrate: async () => {
    const config = loadConfig(migrateShape);
    const database = createDb({ url: config.dbUrl, applicationName: "notify-migrate" });
    try {
      const applied = await migrate(database.db, MIGRATIONS_DIR, (m) => process.stdout.write(`${m}\n`));
      process.stdout.write(`migrations up to date (${applied.length} applied)\n`);
    } finally {
      await database.close();
    }
    return undefined;
  },
});

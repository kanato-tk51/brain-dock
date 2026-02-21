import { buildApp } from "./lib/app.js";
import { MemoryStore } from "./services/memory-store.js";
import { createPgStore } from "./services/pg-store.js";
import type { DataStore } from "./services/store.js";

const port = Number(process.env.PORT ?? 8787);
const host = process.env.HOST ?? "0.0.0.0";

async function main() {
  const dsn = process.env.NEON_DATABASE_URL;
  const store: DataStore = dsn ? createPgStore(dsn) : new MemoryStore();
  const app = await buildApp(store);

  app.addHook("onClose", async () => {
    if (store.close) {
      await store.close();
    }
  });

  try {
    await app.listen({ port, host });
    app.log.info(`brain-dock-api listening on http://${host}:${port} (store=${store.kind()})`);
  } catch (error) {
    app.log.error(error);
    process.exit(1);
  }
}

void main();

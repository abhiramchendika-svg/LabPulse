import { loadConfig } from './config.js';
import { createDb, migrate } from './db.js';
import { MemoryBus, RedisBus, type Bus } from './bus.js';
import { Repo } from './repo.js';
import { buildServer } from './server.js';

async function main() {
  const config = loadConfig();
  const db = createDb(config.databaseUrl);

  // Postgres may still be starting (docker compose): retry for up to a minute.
  for (let attempt = 1; ; attempt++) {
    try {
      await migrate(db);
      break;
    } catch (err) {
      if (attempt >= 30) throw err;
      console.log(`Waiting for Postgres (${(err as Error).message})…`);
      await new Promise((r) => setTimeout(r, 2000));
    }
  }

  let bus: Bus;
  if (config.redisUrl) {
    const redis = new RedisBus(config.redisUrl);
    await redis.ready();
    bus = redis;
  } else {
    console.log('REDIS_URL not set: using in-process bus (single server only).');
    bus = new MemoryBus();
  }

  const app = await buildServer({ config, repo: new Repo(db), bus });
  await app.listen({ port: config.port, host: config.host });
  console.log(`Server listening on port ${config.port}. Open http://localhost:${config.port}/teach`);
  if (config.publicUrl) console.log(`Students join at ${config.publicUrl}`);

  const shutdown = async () => {
    await app.close();
    await bus.close();
    await db.end();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

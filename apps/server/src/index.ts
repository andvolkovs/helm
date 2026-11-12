import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { openDb } from '@helm/db';
import { createProviders } from '@helm/providers';
import { createApp } from './app.ts';
import { scheduleBackups } from './backups.ts';
import { loadConfig } from './config.ts';
import { EventBus } from './core/events/bus.ts';
import { createServices, type ServiceContext } from './core/services/index.ts';
import { assistantModule } from './modules/assistant/index.ts';
import { mcpModule } from './modules/mcp/index.ts';
import { timerModule } from './modules/timer/index.ts';
import { voiceModule } from './modules/voice/index.ts';
import { keyWordsModule } from './modules/key-words/index.ts';

const config = loadConfig();
if (config.ownerPassword.length < 12) {
  console.warn(
    'HELM_OWNER_PASSWORD is short. Use at least 12 characters: it is the only thing between the network and your board.',
  );
}
// A stray failure in background work (key words, push) is logged, not fatal.
process.on('unhandledRejection', (reason) => console.error('Unhandled rejection:', reason));
const { db, backup, close } = openDb({ path: config.dbPath, migrationsFolder: config.migrationsDir });
const ctx: ServiceContext = {
  db,
  bus: new EventBus(),
  rules: config.rules,
  now: () => new Date(),
  historyKeepDays: config.historyKeepDays,
};
const services = createServices(ctx);

const stopBackups =
  config.backups.keep > 0 ? scheduleBackups({ dir: config.backups.dir, keep: config.backups.keep, backup }) : () => {};

// The change log is thinned out shortly after start and then once a day (see ActivityService.prune).
const pruneEvents = () => {
  try {
    const { removed } = services.activity.prune();
    if (removed > 0) console.log(`Activity log: removed ${removed} old entries`);
  } catch (e) {
    console.error('Activity log: pruning failed:', e);
  }
};
setTimeout(pruneEvents, 2 * 60_000).unref();
setInterval(pruneEvents, 24 * 60 * 60_000).unref();

const providers = createProviders(config.ai);
for (const reason of Object.values(providers.reasons)) if (reason) console.log(`AI: ${reason}`);

const app = await createApp({ config, ctx, services, providers, modules: [mcpModule, voiceModule, assistantModule, timerModule, keyWordsModule] });

// Production: serve the built PWA and fall back to index.html for client-side routes.
const webRoot = config.webDist ? resolve(config.webDist) : null;
if (webRoot && !existsSync(join(webRoot, 'index.html'))) {
  console.warn(`HELM_WEB_DIST is set but ${webRoot} has no build yet. Run \`pnpm build\`; serving the API only.`);
} else if (webRoot) {
  const indexHtml = readFileSync(join(webRoot, 'index.html'), 'utf8');
  app.use(
    '/*',
    serveStatic({
      root: webRoot,
      onFound: (path, c) => {
        // Hashed build output never changes; everything else (index, service worker, manifest)
        // must be revalidated so a new deploy is picked up.
        c.header(
          'Cache-Control',
          /[\\/]assets[\\/]/.test(path) ? 'public, max-age=31536000, immutable' : 'no-cache',
        );
      },
    }),
  );
  app.get('*', (c) => {
    c.header('Cache-Control', 'no-cache');
    return c.html(indexHtml);
  });
}

const server = serve({ fetch: app.fetch, port: config.port, hostname: config.host }, (info) => {
  const where = config.host === '0.0.0.0' || config.host === '::' ? 'all interfaces' : config.host;
  console.log(`Helm server listening on port ${info.port} (${where})`);
});

function shutdown() {
  stopBackups();
  server.close();
  close();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

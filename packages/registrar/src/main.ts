import { loadRegistrarConfig } from './config';
import { createRegistrarServer } from './server';

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const configPath = argValue('--config');
if (!configPath) {
  console.error('usage: registrar --config <path-to-config.json>');
  process.exit(1);
}

const config = loadRegistrarConfig(configPath);
const app = await createRegistrarServer(config);
await app.listen({ port: config.port, host: config.host ?? '127.0.0.1' });
console.log(`[registrar] listening on http://${config.host ?? '127.0.0.1'}:${config.port} (db: ${config.dbPath})`);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void app.close().then(() => process.exit(0));
  });
}

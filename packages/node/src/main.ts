import { loadNodeConfig } from './config';
import { createNode } from './node';

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const configPath = argValue('--config');
if (!configPath) {
  console.error('usage: node --config <path-to-config.json>');
  process.exit(1);
}

const config = loadNodeConfig(configPath);
const node = await createNode(config);
await node.start();

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void node.stop().then(() => process.exit(0));
  });
}

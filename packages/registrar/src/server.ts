import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import type { RegistrarConfig } from './config';
import { RegistrarDb } from './db';
import { registerPublicRoutes } from './routes/public';
import { registerAdminRoutes } from './routes/admin';

export async function createRegistrarServer(config: RegistrarConfig): Promise<FastifyInstance> {
  const app = Fastify({ logger: false, bodyLimit: 64 * 1024 });
  await app.register(cors, {
    origin: true,
    allowedHeaders: ['content-type', 'x-admin-key'],
  });

  const db = new RegistrarDb(config.dbPath);
  app.addHook('onClose', async () => {
    db.close();
  });

  app.get('/health', async () => ({ ok: true, service: 'votechain-registrar', chainId: config.chainId }));

  registerPublicRoutes(app, db, config);
  registerAdminRoutes(app, db, config);
  return app;
}

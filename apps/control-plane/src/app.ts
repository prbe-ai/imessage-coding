/**
 * Hono app composition.
 *
 * Mounts: health, the agentphone webhook (raw-body HMAC), and the device API
 * (Bearer device_token). The app is framework-agnostic (Bun or Node) — the
 * runtime entrypoint lives in ./index.ts.
 */
import { Hono } from 'hono';
import { healthRoute } from './routes/health.ts';
import { webhookRoute } from './routes/webhook.ts';
import { deviceRoutes } from './routes/device.ts';

export function createApp(): Hono {
  const app = new Hono();

  app.route('/', healthRoute);
  app.route('/', webhookRoute);
  app.route('/', deviceRoutes);

  app.notFound((c) => c.json({ error: 'not_found' }, 404));
  app.onError((err, c) => {
    console.error('[app] unhandled error', err);
    return c.json({ error: 'internal_error' }, 500);
  });

  return app;
}

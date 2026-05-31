/**
 * Health + readiness.
 *
 *   GET /healthz  — liveness (process is up).
 *   GET /readyz   — readiness (can reach Neon).
 */
import { Hono } from 'hono';
import { query } from '../db/pool.ts';

export const healthRoute = new Hono();

healthRoute.get('/healthz', (c) => c.json({ ok: true }));

healthRoute.get('/readyz', async (c) => {
  try {
    await query('SELECT 1');
    return c.json({ ok: true, db: 'up' });
  } catch (err) {
    console.error('[readyz] db check failed', err);
    return c.json({ ok: false, db: 'down' }, 503);
  }
});

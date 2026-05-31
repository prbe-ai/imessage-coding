/**
 * Neon Postgres access via a shared `pg` Pool.
 *
 * The app tier is stateless — this Pool is the only long-lived resource, and it
 * is safe to share across requests. A SEPARATE dedicated client is used for
 * LISTEN/NOTIFY (see ./listener.ts) because LISTEN occupies a connection.
 */
import { Pool, type PoolClient, type QueryResultRow } from 'pg';
import { loadEnv } from '../env.ts';

let pool: Pool | undefined;

/** Lazily construct (and memoize) the shared Pool. */
export function getPool(): Pool {
  if (pool) return pool;
  const env = loadEnv();
  pool = new Pool({
    connectionString: env.databaseUrl,
    // Neon serverless: keep the pool modest; the app tier scales horizontally.
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
  });
  // A pool 'error' on an idle client must not crash the process.
  pool.on('error', (err: Error) => {
    console.error('[db] idle client error', err.message);
  });
  return pool;
}

/** Run a parameterized query against the shared pool. */
export async function query<R extends QueryResultRow = QueryResultRow>(
  text: string,
  params: ReadonlyArray<unknown> = [],
): Promise<R[]> {
  const res = await getPool().query<R>(text, params as unknown[]);
  return res.rows;
}

/** Run a query expecting at most one row. */
export async function queryOne<R extends QueryResultRow = QueryResultRow>(
  text: string,
  params: ReadonlyArray<unknown> = [],
): Promise<R | undefined> {
  const rows = await query<R>(text, params);
  return rows[0];
}

/**
 * Run `fn` inside a transaction, committing on success and rolling back on any
 * throw. The borrowed client is always released.
 */
export async function withTransaction<T>(
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      /* ignore rollback failure; surface the original error */
    }
    throw err;
  } finally {
    client.release();
  }
}

/** Close the pool (used on graceful shutdown). */
export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = undefined;
  }
}

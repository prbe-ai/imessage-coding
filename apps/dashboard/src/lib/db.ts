/**
 * Shared pg Pool for the dashboard's own product-data queries (accounts,
 * onboarding_tokens, pairing_tokens, conversations, live sessions read-side).
 *
 * Distinct from the Pool Better Auth owns (src/lib/idp/auth.ts) only at the
 * code level — both point at the same Neon database via DATABASE_URL. Lazy so
 * `next build` never opens a connection.
 *
 * Server-only.
 */

import "server-only";

import { Pool, type QueryResult, type QueryResultRow } from "pg";

import { ENV } from "@/lib/idp/env";

let pool: Pool | null = null;

export function getDb(): Pool {
  if (!pool) {
    pool = new Pool({ connectionString: ENV.databaseUrl() });
  }
  return pool;
}

/** Thin typed query helper. */
export async function query<T extends QueryResultRow>(
  text: string,
  params?: ReadonlyArray<unknown>,
): Promise<QueryResult<T>> {
  return getDb().query<T>(text, params as unknown[] | undefined);
}

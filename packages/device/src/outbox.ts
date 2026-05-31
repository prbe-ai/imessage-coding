/**
 * @imsg/device — durable attention-event outbox (file-backed).
 *
 * The spike posted to localhost and never persisted; productized, attention
 * events POST to the cloud control plane and MUST survive transient network
 * failure. We use a JSONL file (one queued POST per line) instead of SQLite to
 * stay dependency-free (a SQLite-or-file outbox both satisfy the durability
 * contract). Concurrency is single-writer in practice (one
 * channel server per session), and writes are append-only + atomic-rewrite on
 * drain, so a crash loses at most the in-flight rewrite, not the whole queue.
 *
 * Retry uses the same exponential backoff (cap 300s) + classification as the
 * tap-plugin: SUCCESS drops the row, POISON drops it (logged), HALT clears the
 * queue and signals the caller to stop, RETRY reschedules with backoff.
 *
 * Outbox cap: oldest rows are reaped once the file exceeds OUTBOX_CAP_BYTES so
 * a long offline stretch can't grow it unbounded.
 */
import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';
import { DeviceApiRoute, type AttentionEvent } from '@imsg/shared';
import { deviceApiUrl, outboxFile } from './config.ts';
import { Classification, backoffMs, postJson } from './httpclient.ts';

export const OUTBOX_CAP_BYTES = 16 * 1024 * 1024;

interface OutboxRow {
  /** Monotonic-ish id for ordering + dedupe within a process. */
  id: number;
  /** The attention events to POST as one batch. */
  events: AttentionEvent[];
  createdAt: number;
  nextAttemptAt: number;
  attemptCount: number;
  lastError: string;
}

/** Raised when the server returns 401 — the device token is dead. */
export class HaltError extends Error {}

function nowMs(): number {
  return Date.now();
}

function readRows(): OutboxRow[] {
  let text: string;
  try {
    text = readFileSync(outboxFile(), 'utf8');
  } catch {
    return [];
  }
  const rows: OutboxRow[] = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const row = JSON.parse(trimmed) as OutboxRow;
      if (Array.isArray(row.events) && typeof row.id === 'number') rows.push(row);
    } catch {
      /* skip corrupt line */
    }
  }
  return rows;
}

/** Atomic full rewrite (tmp + rename) — used after a drain mutates the queue. */
function writeRows(rows: OutboxRow[]): void {
  const p = outboxFile();
  mkdirSync(dirname(p), { recursive: true });
  const tmp = p + '.tmp';
  writeFileSync(tmp, rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''));
  renameSync(tmp, p);
}

/** Enqueue a batch of attention events (append-only — cheap, crash-safe). */
export function enqueue(events: AttentionEvent[]): void {
  if (events.length === 0) return;
  const p = outboxFile();
  mkdirSync(dirname(p), { recursive: true });
  const row: OutboxRow = {
    id: nowMs(),
    events,
    createdAt: nowMs(),
    nextAttemptAt: nowMs(),
    attemptCount: 0,
    lastError: '',
  };
  appendFileSync(p, JSON.stringify(row) + '\n');
  enforceCap();
}

/** Reap oldest rows until the outbox file is under the cap. */
function enforceCap(): void {
  let size = 0;
  try {
    size = statSync(outboxFile()).size;
  } catch {
    return;
  }
  if (size <= OUTBOX_CAP_BYTES) return;
  const rows = readRows();
  // Drop oldest (lowest id) until we estimate under cap.
  rows.sort((a, b) => a.id - b.id);
  while (rows.length > 0) {
    const bytes = rows.reduce((acc, r) => acc + JSON.stringify(r).length + 1, 0);
    if (bytes <= OUTBOX_CAP_BYTES) break;
    rows.shift();
  }
  writeRows(rows);
}

/**
 * Drain every due row once. POSTs each due batch to /api/device/attention with
 * the bearer token. Returns the number of rows successfully shipped.
 * Throws HaltError on 401 (caller clears creds + stops).
 */
export async function drain(token: string): Promise<number> {
  const rows = readRows();
  if (rows.length === 0) return 0;
  rows.sort((a, b) => a.id - b.id);

  const now = nowMs();
  const url = deviceApiUrl(DeviceApiRoute.ATTENTION);
  const survivors: OutboxRow[] = [];
  let shipped = 0;

  for (const row of rows) {
    if (row.nextAttemptAt > now) {
      survivors.push(row);
      continue;
    }
    const resp = await postJson(url, JSON.stringify({ events: row.events }), { bearer: token });

    if (resp.classification === Classification.SUCCESS) {
      shipped += 1;
      continue; // drop the row
    }
    if (resp.classification === Classification.POISON) {
      // Unrecoverable for this payload (e.g. 400 bad shape) — drop + log.
      process.stderr.write(
        `[imsg-device] outbox poison drop id=${row.id} status=${resp.status} body=${resp.body.slice(0, 200)}\n`,
      );
      continue;
    }
    if (resp.classification === Classification.HALT) {
      // Token revoked — clear the whole queue (nothing will ever ship) + signal.
      writeRows([]);
      throw new HaltError('device token revoked (401)');
    }
    // RETRY — reschedule with backoff.
    row.attemptCount += 1;
    row.nextAttemptAt = now + backoffMs(row.attemptCount);
    row.lastError = resp.error || `http ${resp.status}`;
    survivors.push(row);
  }

  writeRows(survivors);
  return shipped;
}

/** Current queued row count (for status). */
export function rowCount(): number {
  return readRows().length;
}

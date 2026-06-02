#!/usr/bin/env bun
/**
 * @imsg/device — per-session transcript TAP daemon.
 *
 * Spawned (detached) by the SessionStart hook with the session's real id +
 * transcript path. It tails the Claude Code `.jsonl` transcript, reduces each
 * new block to a lightweight ActivityEvent (see activity.ts), and ships batches
 * to POST /api/device/activity — but ONLY while the device is AFK. At the
 * keyboard it still advances its byte cursor (so flipping AFK on never dumps a
 * backlog of at-keyboard activity), it just ships nothing.
 *
 * One daemon per session (keyed by CC's real session id). State (cursor, outbox)
 * is per-session, so concurrent sessions never share a writer — unlike the MCP
 * server's shared attention outbox. Reuses the device's token / killswitch /
 * http-classification primitives.
 *
 * Exits cleanly on: SIGTERM/SIGINT, the shutdown sentinel (SessionEnd), a 401
 * halt, the transcript missing for several ticks, or an orphaned session (no
 * process holds the transcript open — CC was hard-killed without SessionEnd).
 *
 * Usage: bun run bin/tap.ts --session-id <id> --transcript <path> --cwd <dir>
 */
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import {
  ActivityKind,
  AfkState,
  DeviceApiRoute,
  SESSION_TITLE_MAX_LEN,
  type ActivityBatchBody,
  type ActivityEvent,
} from '@imsg/shared';
import {
  deviceApiUrl,
  logDir,
  sessionCursorFile,
  sessionOutboxFile,
  sessionShutdownFile,
  sessionTitleFile,
  sessionsDir,
} from '../src/config.ts';
import { loadToken } from '../src/creds.ts';
import { egressEnabled } from '../src/killswitch.ts';
import { readAfk } from '../src/state.ts';
import { Classification, backoffMs, postJson } from '../src/httpclient.ts';
import { readNew } from '../src/transcript.ts';
import { extractActivity } from '../src/activity.ts';

// --- cadence + safety constants ----------------------------------------------
const ACTIVE_INTERVAL_MS = 20_000; // transcript advancing → near-real-time
const IDLE_INTERVAL_MS = 120_000; // quiet session → back off
const IDLE_THRESHOLD_TICKS = 2; // empty ticks in a row before going idle
const MISSING_LIMIT = 5; // transcript gone this many ticks → exit
const ORPHAN_CHECK_EVERY = 12; // run the lsof orphan check every N ticks
const ORPHAN_TIMEOUT_MS = 5_000;
const MAX_DRAIN_PER_TICK = 32;
const MAX_EVENTS_PER_BATCH = 500; // chunk a big catch-up into bounded POSTs

// --- args --------------------------------------------------------------------
function arg(name: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < process.argv.length ? String(process.argv[i + 1]) : '';
}
const SESSION_ID = arg('session-id');
const TRANSCRIPT = arg('transcript');
const CWD = arg('cwd');

mkdirSync(sessionsDir(), { recursive: true });
mkdirSync(logDir(), { recursive: true });
const LOG = join(logDir(), `tap-${SESSION_ID}.log`);
function log(event: string, data: Record<string, unknown> = {}): void {
  try {
    appendFileSync(LOG, JSON.stringify({ ts: new Date().toISOString(), event, ...data }) + '\n');
  } catch {
    /* best-effort */
  }
}

// --- cursor (byte offset + line number), persisted per session ---------------
interface Cursor {
  byteOffset: number;
  lineNo: number;
}
function readCursor(): Cursor {
  try {
    const c = JSON.parse(readFileSync(sessionCursorFile(SESSION_ID), 'utf8')) as Partial<Cursor>;
    return {
      byteOffset: typeof c.byteOffset === 'number' ? c.byteOffset : 0,
      lineNo: typeof c.lineNo === 'number' ? c.lineNo : 0,
    };
  } catch {
    return { byteOffset: 0, lineNo: 0 };
  }
}
function writeCursor(c: Cursor): void {
  const path = sessionCursorFile(SESSION_ID);
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(c), 'utf8');
  renameSync(tmp, path);
}

// --- durable per-session outbox (JSONL of un-shipped batches) ----------------
interface OutboxRow {
  id: number;
  body: string; // serialized ActivityBatchBody
  nextAttemptAt: number;
  attemptCount: number;
}
// Seed from wall-clock so ids stay monotonic across daemon restarts (a fresh
// process must not reissue low ids that sort before un-shipped rows on disk).
let outboxSeq = Date.now();
function enqueue(body: string): void {
  const row: OutboxRow = { id: ++outboxSeq, body, nextAttemptAt: 0, attemptCount: 0 };
  appendFileSync(sessionOutboxFile(SESSION_ID), JSON.stringify(row) + '\n');
}
function readOutbox(): OutboxRow[] {
  let text: string;
  try {
    text = readFileSync(sessionOutboxFile(SESSION_ID), 'utf8');
  } catch {
    return [];
  }
  const rows: OutboxRow[] = [];
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try {
      const r = JSON.parse(t) as OutboxRow;
      if (typeof r.id === 'number' && typeof r.body === 'string') rows.push(r);
    } catch {
      /* skip corrupt line */
    }
  }
  return rows;
}
function writeOutbox(rows: OutboxRow[]): void {
  const path = sessionOutboxFile(SESSION_ID);
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''));
  renameSync(tmp, path);
}

class HaltError extends Error {}

/** Post every due batch once. Returns rows shipped. Throws HaltError on 401. */
async function drain(token: string): Promise<number> {
  const rows = readOutbox();
  if (rows.length === 0) return 0;
  rows.sort((a, b) => a.id - b.id);
  const now = Date.now();
  const url = deviceApiUrl(DeviceApiRoute.ACTIVITY);
  const survivors: OutboxRow[] = [];
  let shipped = 0;
  let processed = 0;
  for (const row of rows) {
    // Honor a shutdown mid-drain: keep the rest queued and bail promptly.
    if (shutdownObserved()) {
      survivors.push(row);
      continue;
    }
    if (row.nextAttemptAt > now || processed >= MAX_DRAIN_PER_TICK) {
      survivors.push(row);
      continue;
    }
    processed += 1;
    const resp = await postJson(url, row.body, { bearer: token });
    if (resp.classification === Classification.SUCCESS) {
      shipped += 1;
      continue; // drop
    }
    if (resp.classification === Classification.POISON) {
      log('outbox_poison', { id: row.id, status: resp.status, body: resp.body.slice(0, 200) });
      continue; // unrecoverable for this payload — drop
    }
    if (resp.classification === Classification.HALT) {
      writeOutbox([]);
      throw new HaltError('device token revoked (401)');
    }
    row.attemptCount += 1;
    row.nextAttemptAt = now + backoffMs(row.attemptCount);
    survivors.push(row);
  }
  writeOutbox(survivors);
  return shipped;
}

// --- transcript → activity batches -------------------------------------------
/** Turn a tick's new lines into ActivityEvents tagged with transcript position. */
function buildEvents(lines: string[], baseLineNo: number, at: string): ActivityEvent[] {
  const events: ActivityEvent[] = [];
  for (let i = 0; i < lines.length; i++) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(lines[i]!);
    } catch {
      continue; // non-JSON line (shouldn't happen) — skip, cursor still advances
    }
    const extracted = extractActivity(parsed);
    for (let b = 0; b < extracted.length; b++) {
      const e = extracted[b]!;
      const ev: ActivityEvent = { lineNo: baseLineNo + i, blockIdx: b, kind: e.kind, at };
      if (e.toolName !== undefined) ev.toolName = e.toolName;
      if (e.text !== undefined) ev.text = e.text;
      if (e.summary !== undefined) ev.summary = e.summary;
      if (e.isError !== undefined) ev.isError = e.isError;
      events.push(ev);
    }
  }
  return events;
}

/** Enqueue events as one or more bounded batches. */
function enqueueEvents(events: ActivityEvent[]): void {
  for (let i = 0; i < events.length; i += MAX_EVENTS_PER_BATCH) {
    const chunk = events.slice(i, i + MAX_EVENTS_PER_BATCH);
    const body: ActivityBatchBody = { sessionId: SESSION_ID, events: chunk };
    if (CWD) body.cwd = CWD;
    enqueue(JSON.stringify(body));
  }
}

// --- session title (first user message) --------------------------------------
// The channel MCP server reads this file and forwards it on the heartbeat. It's
// a LOCAL write (not egress), so it's deliberately OUTSIDE the AFK ship-gate —
// the title is a session LABEL (metadata, like cwd), not transcript content, so
// it populates even at the keyboard. Captured ONCE per session, then frozen.
let titleCaptured = existsSync(sessionTitleFile(SESSION_ID));

/** Atomically write the session title (already sanitized by extractActivity).
 *  Returns true only on a confirmed write — the caller must NOT mark the title
 *  captured on failure, or it's lost forever (the byte cursor advances past the
 *  first user message each tick, so a failed write is never re-scanned). */
function writeTitle(text: string): boolean {
  try {
    const path = sessionTitleFile(SESSION_ID);
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, text, 'utf8');
    renameSync(tmp, path);
    return true;
  } catch {
    return false; // best-effort — retried next tick that has lines (title non-critical)
  }
}

/**
 * Scan this tick's new transcript lines for the FIRST user message and capture
 * it as the title (truncated). Runs regardless of AFK; no-ops once captured. The
 * cursor starts at byte 0 on a fresh session, so the first run always sees the
 * opening user turn.
 */
function maybeCaptureTitle(lines: string[]): void {
  if (titleCaptured) return;
  for (const line of lines) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    for (const a of extractActivity(parsed)) {
      if (a.kind === ActivityKind.USER_MESSAGE && a.text && a.text.trim()) {
        const title = a.text.trim().slice(0, SESSION_TITLE_MAX_LEN);
        // Only mark captured on a CONFIRMED write. On a (rare) write failure we
        // leave titleCaptured false and fall through future ticks: the cursor has
        // already advanced past this message, so the title ends up being the NEXT
        // user message rather than the first — acceptable degradation, and far
        // better than the alternative (marking captured on a failed write would
        // freeze the title at NULL forever).
        if (writeTitle(title)) {
          titleCaptured = true;
          log('title_captured', { len: title.length });
        }
        return;
      }
    }
  }
}

// --- orphan detection (CC hard-killed without SessionEnd) ---------------------
/** True/false if lsof can tell; null if lsof unavailable (treat as "alive"). */
function transcriptHasReader(): boolean | null {
  try {
    const r = spawnSync('lsof', ['-t', '--', TRANSCRIPT], {
      encoding: 'utf8',
      timeout: ORPHAN_TIMEOUT_MS,
    });
    if (r.error) return null;
    return Boolean((r.stdout ?? '').trim());
  } catch {
    return null;
  }
}

// --- main loop ---------------------------------------------------------------
let shutdownRequested = false;
function shutdownObserved(): boolean {
  return shutdownRequested || existsSync(sessionShutdownFile(SESSION_ID));
}
process.on('SIGTERM', () => {
  shutdownRequested = true;
});
process.on('SIGINT', () => {
  shutdownRequested = true;
});

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function main(): Promise<number> {
  if (!SESSION_ID || !TRANSCRIPT) {
    log('bad_args', { sessionId: SESSION_ID, transcript: TRANSCRIPT });
    return 2;
  }
  const token = loadToken();
  if (!token) {
    log('no_token', { hint: 'device not paired' });
    return 0;
  }
  log('tap_start', { transcript: TRANSCRIPT, cwd: CWD });

  let cursor = readCursor();
  let missing = 0;
  let tick = 0;
  let emptyTicks = 0;
  let idle = false;
  let sawReader = false;
  let orphanMisses = 0;

  while (!shutdownObserved()) {
    tick += 1;

    // Killswitch (device-level egress, fails OPEN on network error). We still TAIL
    // and advance the cursor when disabled — we just don't ship or drain. Pairing
    // that with the AFK gate below means a later killswitch-off / AFK-on never
    // dumps the backlog that accumulated meanwhile.
    const enabled = await egressEnabled(token).catch(() => true);
    // Ship ONLY while egress is on AND the user is away. Always advance the cursor
    // regardless, so at-keyboard / killswitched activity is skipped, not queued.
    const shipping = enabled && readAfk() === AfkState.ON;

    let hadLines = false;
    try {
      const res = readNew(TRANSCRIPT, cursor.byteOffset);
      missing = 0;
      if (res.lines.length > 0) {
        hadLines = true;
        // Capture the title (first user message) regardless of AFK — it's a local
        // write, not egress, so it's outside the ship-gate below.
        maybeCaptureTitle(res.lines);
        // lineNo is a MONOTONIC per-session event index (never reset), so it stays
        // a stable, unique dedup key derived from the (uncommitted-until-success)
        // cursor: a crash-before-commit re-read re-derives the same lineNos and the
        // server's ON CONFLICT de-dupes. (On the effectively-impossible transcript
        // shrink, the byte cursor resets but lineNo keeps climbing, so re-read lines
        // get fresh keys and re-ship rather than silently colliding/dropping.)
        if (shipping) {
          const events = buildEvents(res.lines, cursor.lineNo, new Date().toISOString());
          if (events.length > 0) enqueueEvents(events);
        }
        cursor = { byteOffset: res.newByteOffset, lineNo: cursor.lineNo + res.lines.length };
        writeCursor(cursor);
      }
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code === 'ENOENT') {
        missing += 1;
        log('transcript_missing', { tick: missing });
        if (missing >= MISSING_LIMIT) {
          log('transcript_gone_exit', {});
          return 0;
        }
      } else {
        log('read_error', { error: err instanceof Error ? err.message : String(err) });
      }
    }

    // Drain only while egress is enabled — the killswitch pauses delivery, and a
    // batch enqueued while AFK still ships (it's AFK-era activity).
    if (enabled) {
      try {
        const shipped = await drain(token);
        if (shipped > 0) log('drained', { shipped });
      } catch (err) {
        if (err instanceof HaltError) {
          log('halt', { reason: '401 token revoked' });
          return 1;
        }
        log('drain_error', { error: err instanceof Error ? err.message : String(err) });
      }
    }

    // Orphan check: CC keeps the transcript fd open for the session's lifetime.
    // No reader (after we've seen one) => CC died without SessionEnd; exit.
    if (tick % ORPHAN_CHECK_EVERY === 0) {
      const has = transcriptHasReader();
      if (has === true) {
        sawReader = true;
        orphanMisses = 0;
      } else if (has === false && sawReader) {
        // Require TWO consecutive misses — macOS lsof can transiently return
        // empty for a busy open fd, and one false positive would kill a live tap.
        orphanMisses += 1;
        if (orphanMisses >= 2) {
          log('orphan_exit', {});
          try {
            writeFileSync(sessionShutdownFile(SESSION_ID), '');
          } catch {
            /* best-effort */
          }
          return 0;
        }
      }
    }

    // Adaptive cadence.
    if (hadLines) {
      emptyTicks = 0;
      idle = false;
    } else if (++emptyTicks >= IDLE_THRESHOLD_TICKS) {
      idle = true;
    }
    await sleepResponsive(idle ? IDLE_INTERVAL_MS : ACTIVE_INTERVAL_MS);
  }
  return 0;
}

/** Sleep in 1s slices so the shutdown sentinel / SIGTERM is honored promptly. */
async function sleepResponsive(ms: number): Promise<void> {
  let slept = 0;
  while (slept < ms && !shutdownObserved()) {
    await sleep(1_000);
    slept += 1_000;
  }
}

const code = await main();
log('tap_exit', { code });
process.exit(code);

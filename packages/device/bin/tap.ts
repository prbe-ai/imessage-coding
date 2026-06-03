#!/usr/bin/env bun
/**
 * @imsg/device — per-session transcript TAP daemon.
 *
 * Spawned (detached) by the SessionStart hook with the session's real id +
 * transcript path. It tails the Claude Code `.jsonl` transcript, reduces each
 * new block to a lightweight ActivityEvent (see activity.ts), and ships batches
 * to POST /api/device/activity in REALTIME whenever the killswitch permits — at
 * the keyboard or AFK — so the control plane's activity log is always current for
 * get_session_data. Only the device killswitch gates shipping; the byte cursor
 * advances regardless, so a killswitched stretch is skipped, not queued.
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
  AgentKind,
  DeviceApiRoute,
  SESSION_TITLE_MAX_LEN,
  type ActivityBatchBody,
  type ActivityEvent,
} from '@imsg/shared';
import {
  agentKind,
  deviceApiUrl,
  logDir,
  migrateLegacyDeviceDir,
  sessionCursorFile,
  sessionOutboxFile,
  sessionShutdownFile,
  sessionTitleFile,
  sessionsDir,
} from '../src/config.ts';
import { loadToken } from '../src/creds.ts';
import { egressEnabled } from '../src/killswitch.ts';
import { Classification, backoffMs, postJson } from '../src/httpclient.ts';
import { readNew } from '../src/transcript.ts';
import { extractActivity, type ExtractedActivity } from '../src/activity.ts';
import { extractCodexActivity } from '../src/transcript-codex.ts';

// --- cadence + safety constants ----------------------------------------------
const ACTIVE_INTERVAL_MS = 10_000; // transcript advancing → near-real-time
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

// Which agent's transcript are we tailing? Set by the spawning SessionStart hook
// via IMSG_AGENT_KIND (codex for the Codex hook; unset/claude-code for CC). The
// byte-offset cursor tailing (readNew) is format-agnostic and SHARED; only the
// per-line reduction (CC's extractActivity vs Codex's extractCodexActivity) and
// the title source (CC ai-title/custom-title vs Codex first-user-message) differ.
const AGENT = agentKind();
const IS_CODEX = AGENT === AgentKind.CODEX;

/** Reduce one parsed transcript/rollout line to coarse activity units, using the
 *  reducer for the active agent. The output {@link ExtractedActivity} shape is
 *  identical for both, so everything downstream (buildEvents, blockIdx, the
 *  provisional first-message title) is agent-agnostic. */
function reduceLine(parsed: unknown): ExtractedActivity[] {
  return IS_CODEX ? extractCodexActivity(parsed) : extractActivity(parsed);
}

// Relocate pre-0.1.7 state into ~/.imsg before reading this session's cursor.
migrateLegacyDeviceDir();
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
    const extracted = reduceLine(parsed);
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

// --- session title (CC-generated > /rename > first user message) --------------
// The channel MCP server reads `<id>.title` and forwards it on the heartbeat.
// It's a LOCAL write (not egress), so — like cwd — it's deliberately OUTSIDE the
// AFK ship-gate: the title is a session LABEL, not transcript content, so it
// populates even at the keyboard.
//
// Source priority (low → high): the first user message is only a PROVISIONAL
// fallback (for a slash-command session it's raw <command-…> XML); we upgrade to
// Claude Code's own LLM title — persisted in the transcript as
// {"type":"ai-title","aiTitle":"…"} — and to a user /rename
// ({"type":"custom-title","customTitle":"…"}) when present. The control plane
// takes the newest non-null title, so a heartbeat re-sending the same final
// title is idempotent, and the label upgrades in place as CC fills it in.
const TitleRank = { NONE: 0, FIRST_MESSAGE: 1, AI: 2, CUSTOM: 3 } as const;
type TitleRank = (typeof TitleRank)[keyof typeof TitleRank];
let titleRank: TitleRank = TitleRank.NONE;

/** Normalize a title to a single trimmed line within the length cap. */
function cleanTitle(text: string): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, SESSION_TITLE_MAX_LEN);
}

/** Atomically write `<id>.title`. Returns true only on a confirmed write — the
 *  caller must NOT advance `titleRank` on failure, or a better title we've
 *  already scanned past would never be retried. */
function writeTitle(text: string): boolean {
  try {
    const path = sessionTitleFile(SESSION_ID);
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, text, 'utf8');
    renameSync(tmp, path);
    return true;
  } catch {
    return false; // best-effort — retried on a later tick
  }
}

/** Write `rawText` as the title iff `rank` is an upgrade (a re-`/rename` at the
 *  CUSTOM level may also replace). Advances `titleRank` only on a confirmed
 *  write. */
function offerTitle(rank: TitleRank, rawText: string): void {
  if (rank < titleRank) return;
  if (rank === titleRank && rank !== TitleRank.CUSTOM) return;
  const text = cleanTitle(rawText);
  if (!text) return;
  if (writeTitle(text)) {
    titleRank = rank;
    log('title_captured', { rank, len: text.length });
  }
}

/** Turn a provisional first-message into a label. A slash-command turn is stored
 *  as XML (`<command-name>/afk</command-name><command-message>…</command-message>
 *  <command-args>…</command-args>`) — show the command (+ args) instead of the raw
 *  tags, for the rare session that never gets an ai-title (e.g. a bare `/clear`). */
function firstMessageTitle(text: string): string {
  const name = text.match(/<command-name>([^<]*)<\/command-name>/)?.[1]?.trim();
  if (!name) return text;
  const cmdArgs = text.match(/<command-args>([^<]*)<\/command-args>/)?.[1]?.trim();
  return cmdArgs ? `${name} ${cmdArgs}` : name;
}

/** A Claude Code title entry, if this transcript line is one. These rows carry
 *  no `message` block, so extractActivity() skips them — read them directly. */
function readTitleEntry(parsed: unknown): { rank: TitleRank; text: string } | null {
  if (typeof parsed !== 'object' || parsed === null) return null;
  const o = parsed as Record<string, unknown>;
  if (o['type'] === 'custom-title' && typeof o['customTitle'] === 'string')
    return { rank: TitleRank.CUSTOM, text: o['customTitle'] };
  if (o['type'] === 'ai-title' && typeof o['aiTitle'] === 'string')
    return { rank: TitleRank.AI, text: o['aiTitle'] };
  return null;
}

/**
 * Scan transcript lines for the best available title and upgrade `<id>.title`.
 * Prefers CC's ai-title/custom-title; falls back to the first user message only
 * until a real title appears. Runs regardless of AFK; cheap no-op once a CUSTOM
 * title is captured. Used for both the one-time startup seed (full transcript,
 * recovers the title across a CC reload) and the per-tick scan of new lines.
 */
function scanForTitle(lines: string[]): void {
  if (titleRank === TitleRank.CUSTOM) return;
  for (const line of lines) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    const entry = readTitleEntry(parsed);
    if (entry) {
      offerTitle(entry.rank, entry.text);
      continue;
    }
    // Provisional fallback only — stop looking at user messages once we hold any
    // real title, and only ever take the FIRST one. For Codex (no ai-title/
    // custom-title entries) this provisional first user message IS the title,
    // matching firstCodexUserMessage's contract.
    if (titleRank === TitleRank.NONE) {
      for (const a of reduceLine(parsed)) {
        if (a.kind === ActivityKind.USER_MESSAGE && a.text && a.text.trim()) {
          offerTitle(TitleRank.FIRST_MESSAGE, firstMessageTitle(a.text));
          break;
        }
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

  // One-time title seed: scan the existing transcript from the top so a tap that
  // (re)starts mid-session recovers CC's already-written ai-title/custom-title —
  // the per-tick scan below only sees NEW lines past the persisted byte cursor,
  // and the title (~line 11) usually lands before any restart. Reads from byte 0
  // independently of the activity cursor, which is untouched.
  try {
    scanForTitle(readNew(TRANSCRIPT, 0).lines);
  } catch {
    /* transcript not readable yet — the per-tick scan will catch up */
  }

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
    // and advance the cursor when disabled — we just don't ship or drain, so a
    // killswitched stretch is skipped (not queued for a later dump).
    const enabled = await egressEnabled(token).catch(() => true);
    // Ship the activity log in REALTIME whenever egress is on — NOT gated on AFK —
    // so the control plane's session_activity is always current for the orchestrator
    // (get_session_data and the live snapshot), at the keyboard or away. The
    // killswitch is the only gate; the cursor still advances regardless.
    const shipping = enabled;

    let hadLines = false;
    try {
      const res = readNew(TRANSCRIPT, cursor.byteOffset);
      missing = 0;
      if (res.lines.length > 0) {
        hadLines = true;
        // Upgrade the session title (CC ai-title/custom-title, else provisional
        // first message) regardless of the ship gate — it's a local write, not
        // egress, so it stays outside the killswitch gate below.
        scanForTitle(res.lines);
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

    // Drain only while egress is enabled — the killswitch pauses delivery; anything
    // already enqueued ships on the next enabled tick.
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

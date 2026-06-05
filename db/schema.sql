-- =============================================================================
-- imessage-coding — Neon Postgres schema
--
-- Stateless app tier: ALL state lives here. Everything is account-scoped.
-- The control plane wakes SSE streams via LISTEN/NOTIFY triggers (session_inbox,
-- session_state, device_state).
--
-- Better Auth owns its own tables (better_auth_*); the dashboard creates and
-- migrates those via the Better Auth CLI. We reference them only loosely
-- (accounts mirror the authenticated user) and do NOT manage them here.
-- =============================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto; -- gen_random_uuid()

-- -----------------------------------------------------------------------------
-- accounts — the tenant boundary. One row per paying/onboarded user.
-- (Better Auth user/session/account tables live separately as better_auth_*.)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS accounts (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  email       TEXT        NOT NULL UNIQUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- -----------------------------------------------------------------------------
-- agent_numbers — the pool of AgentPhone numbers this deployment owns. Each
-- account is assigned one (see accounts.agent_number_id). Rows are deployment
-- data, seeded from the live AgentPhone API (scripts/seed-agent-numbers.ts) —
-- never committed literals (keeps the OSS repo de-branded).
--
-- Phase 1: ONE active row, shared by every account (assignment is non-exclusive).
-- Phase 2 (dedicated numbers): assignment becomes 1:1 — add UNIQUE(agent_number_id)
-- on accounts and claim a free row with FOR UPDATE SKIP LOCKED. Callers of
-- ensureAgentNumberForAccount() do not change.
--
-- Lifecycle: retire a number by setting active=FALSE (soft), NEVER DELETE — the
-- assigner only serves active rows, and the FK below intentionally has NO ON
-- DELETE action so an accidental delete of an in-use number fails loud.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS agent_numbers (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  phone_number  TEXT        NOT NULL UNIQUE,        -- E.164, e.g. +15551234567
  agent_id      TEXT        NOT NULL,               -- AgentPhone agentId that owns it
  provider_id   TEXT,                               -- AgentPhone number id
  active        BOOLEAN     NOT NULL DEFAULT TRUE,  -- allocatable?
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The account's assigned outbound agent number. NULL until first assigned (or
-- when the pool is empty). Shared-number phase: many accounts -> same row.
ALTER TABLE accounts
  ADD COLUMN IF NOT EXISTS agent_number_id UUID REFERENCES agent_numbers(id);

-- -----------------------------------------------------------------------------
-- devices — a paired machine running the Claude Code plugin.
-- device_token_hash is a peppered hash; the raw token is returned to the
-- device exactly once at pair time and never stored.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS devices (
  id                 UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id         UUID        NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  device_token_hash  TEXT        NOT NULL UNIQUE,
  os                 TEXT,
  hostname           TEXT,
  paired_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at         TIMESTAMPTZ,
  -- Remote killswitch: a non-null disabled_at disables the device WITHOUT
  -- destroying its credential (reversible, unlike revoked_at). The device's
  -- GET /api/device/state reports enabled = (revoked_at IS NULL AND disabled_at IS NULL).
  disabled_at        TIMESTAMPTZ,
  -- AFK is MACHINE-WIDE, so it lives on the device, not the session: the
  -- PreToolUse hook reads ONE shared afk.state file per machine, so a per-session
  -- value is a fiction (and N concurrent sessions' streams clobber the shared
  -- file). A toggle here is the single source of truth; every live session on the
  -- device syncs it down via the SSE `state` event. afk ∈ on|off (string-checked).
  afk                TEXT        NOT NULL DEFAULT 'off'
                       CHECK (afk IN ('on', 'off')),
  -- LOCK for the DEVICE-keyed "lost connection" notice (names the whole machine, not
  -- a session). The reaper owns it (claimDevicesToNotifyLost): it stamps the last time
  -- we texted the user the machine dropped (or silently "handled" an afk-off drop), and
  -- the dedup is CONVERSATION-RELOCK — a dropped device is announced once, then NOT
  -- again until the user RE-ENGAGES (an inbound message newer than this stamp), at which
  -- point a later/continued drop re-announces. So a laptop that just flaps with no
  -- texting from the user is announced exactly once, regardless of flap cadence; NULL =
  -- never announced. Never written by the heartbeat path. See claimDevicesToNotifyLost.
  lost_notified_at   TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_devices_account ON devices(account_id);
-- Idempotent add for already-provisioned DBs (CREATE TABLE IF NOT EXISTS above
-- is a no-op once the table exists). Backfill carries each device's current
-- per-session value (most-recent live session wins) so existing AFK survives.
ALTER TABLE devices ADD COLUMN IF NOT EXISTS afk     TEXT NOT NULL DEFAULT 'off'
  CHECK (afk IN ('on', 'off'));
UPDATE devices d SET afk = s.afk
  FROM (
    SELECT DISTINCT ON (device_id) device_id, afk
      FROM sessions WHERE state <> 'ended'
     ORDER BY device_id, last_event_at DESC
  ) s
 WHERE s.device_id = d.id AND d.afk = 'off';
-- Idempotent add for already-provisioned DBs. Apply to the live DB BEFORE the
-- code deploy: the reaper's claimDevicesToNotifyLost reads/writes this column as the
-- "lost connection" lock.
ALTER TABLE devices ADD COLUMN IF NOT EXISTS lost_notified_at TIMESTAMPTZ;
-- Backfill: claimDevicesToNotifyLost arms on STATE (offline past the debounce + stamp
-- NULL), not on a fresh transition — so without this, the first post-deploy sweep would
-- text a spurious "lost connection" for every AFK machine that already died long ago
-- (their NULL stamp + ended sessions would match). Stamp every device that is ALREADY
-- fully dropped (has sessions, none live) as already-announced. A currently-LIVE device
-- (≥1 non-ended session) stays NULL, so it announces correctly when it later drops. A
-- device stamped here re-announces only if the user RE-ENGAGES (an inbound newer than
-- the stamp) — so a stays-dropped machine texts zero more times. Idempotent — only ever
-- stamps still-NULL rows.
UPDATE devices d SET lost_notified_at = now()
 WHERE d.lost_notified_at IS NULL
   AND EXISTS (SELECT 1 FROM sessions s WHERE s.device_id = d.id)
   AND NOT EXISTS (SELECT 1 FROM sessions s WHERE s.device_id = d.id AND s.state <> 'ended');
-- Drop the short-lived `online_since` column from the superseded heartbeat-hysteresis
-- approach (PR #11). The conversation-relock model (above) re-arms on user engagement,
-- not on an uptime streak, so the column is dead. Idempotent + safe: apply AFTER the
-- relock code is deployed (the new reaper never references online_since; only the
-- superseded code did).
ALTER TABLE devices DROP COLUMN IF EXISTS online_since;

-- -----------------------------------------------------------------------------
-- pairing_tokens — single-use, short-TTL tokens embedded in install.sh and
-- exchanged for a device_token at /api/device/pair.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS pairing_tokens (
  token_hash  TEXT        PRIMARY KEY,
  account_id  UUID        NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  expires_at  TIMESTAMPTZ NOT NULL,
  used_at     TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_pairing_tokens_account ON pairing_tokens(account_id);

-- -----------------------------------------------------------------------------
-- onboarding_tokens — single-use, session-bound, rate-limited tokens minted
-- during dashboard onboarding. The user texts the token in; we match it to
-- derive their phone number, then verify. `attempts` enforces rate limiting.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS onboarding_tokens (
  token_hash      TEXT        PRIMARY KEY,
  account_id      UUID        NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  sso_session_id  TEXT        NOT NULL,
  expires_at      TIMESTAMPTZ NOT NULL,
  used_at         TIMESTAMPTZ,
  attempts        INTEGER     NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_onboarding_tokens_account ON onboarding_tokens(account_id);

-- -----------------------------------------------------------------------------
-- conversations — a verified phone number ↔ account binding. The control plane
-- resolves an inbound message's `from` number to a conversation → account.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS conversations (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id    UUID        NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  phone_number  TEXT        NOT NULL,
  verified_at   TIMESTAMPTZ,
  UNIQUE (phone_number)
);
CREATE INDEX IF NOT EXISTS idx_conversations_account ON conversations(account_id);

-- -----------------------------------------------------------------------------
-- sessions — a live Claude Code session on a device.
-- state ∈ active|waiting|idle|ended ; afk ∈ on|off
-- (string-checked here to match @imsg/shared const-objects).
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sessions (
  id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  device_id      UUID        NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  account_id     UUID        NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  cwd            TEXT,
  -- Human label = the session's first user message (sanitized, truncated). Set
  -- once, then frozen (first-writer-wins in upsertSession). NULL until observed.
  title          TEXT,
  agent          TEXT        NOT NULL DEFAULT 'claude-code',
  state          TEXT        NOT NULL DEFAULT 'active'
                   CHECK (state IN ('active', 'waiting', 'idle', 'ended')),
  -- VESTIGIAL: afk is MACHINE-WIDE and now lives on `devices` (the hook reads one
  -- shared state file per machine). This column is no longer written or read —
  -- SessionInfo.afk is JOINed from the device. Kept only so a mid-deploy old
  -- build doesn't error selecting it; drop once both tiers are on per-device code.
  afk            TEXT        NOT NULL DEFAULT 'off'
                   CHECK (afk IN ('on', 'off')),
  last_event_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_sessions_account ON sessions(account_id);
CREATE INDEX IF NOT EXISTS idx_sessions_device  ON sessions(device_id);

-- -----------------------------------------------------------------------------
-- account_locks — CROSS-MACHINE per-account turn serialization (a LEASE).
-- The orchestrator serializes turns per account in-process, but the app runs on
-- >1 machine; this row is the shared mutex so two machines never run a turn for
-- the same account at once (see db/account-lock.ts). One row per CURRENTLY-held
-- lease: acquire upserts it, the turn deletes it at the end. `expires_at` is a
-- CRASH BACKSTOP — a machine that dies mid-turn never deletes its row, so another
-- can steal the lease once expires_at lapses (acquire's `WHERE expires_at < now()`).
-- Ephemeral (not durable state): rows come and go per turn; no FK so a future
-- account delete can't be blocked by a stray lease, and a stray lease self-heals
-- via its TTL. PK lookup only, so no extra index.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS account_locks (
  account_id  UUID        PRIMARY KEY,
  owner       TEXT        NOT NULL,
  expires_at  TIMESTAMPTZ NOT NULL
);

-- -----------------------------------------------------------------------------
-- attention_events — points where the agent needs the user's attention.
-- kind ∈ permission|question|plan|idle|turn_complete
-- request_id (permission verdict target) and qid (question/plan correlation).
-- `resolved` flips true once a decision lands.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS attention_events (
  id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  device_id      UUID        NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  session_id     UUID        NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  account_id     UUID        NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  kind           TEXT        NOT NULL
                   CHECK (kind IN ('permission', 'question', 'plan', 'idle', 'turn_complete')),
  tool_name      TEXT,
  description    TEXT,
  input_preview  TEXT,
  request_id     TEXT,
  qid            TEXT,
  -- Provider message id of the OUTBOUND phone notification that fronted this
  -- attention. A tapback/inline reply carrying this id binds deterministically
  -- to THIS attention (server-issued, vs. the device-side request_id/qid).
  notify_message_id TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved       BOOLEAN     NOT NULL DEFAULT false
);
CREATE INDEX IF NOT EXISTS idx_attention_account            ON attention_events(account_id);
CREATE INDEX IF NOT EXISTS idx_attention_session            ON attention_events(session_id);
CREATE INDEX IF NOT EXISTS idx_attention_session_unresolved ON attention_events(session_id) WHERE resolved = false;
CREATE INDEX IF NOT EXISTS idx_attention_request_id         ON attention_events(request_id);
CREATE INDEX IF NOT EXISTS idx_attention_qid                ON attention_events(qid);
CREATE INDEX IF NOT EXISTS idx_attention_notify_message_id  ON attention_events(notify_message_id);

-- -----------------------------------------------------------------------------
-- session_inbox — the SINGLE queue of things to deliver INTO a coding-agent
-- session. One row = one delivery, of one of two kinds:
--   kind='reply'   → `text` is injected into the session as a <channel> message
--                    (a question answer, a plan approval/denial, OR a free-text
--                    steer — all "a simple reply" from the user's side).
--   kind='verdict' → `{request_id, behavior}` is relayed on the Channels
--                    permission channel to release a native permission prompt
--                    (the one structured path; text can't release a parked dialog).
--                    For Codex (no native verdict-push channel) the SAME verdict
--                    row is read DIRECTLY by the BLOCKING POST /api/device/permission
--                    handler (matched by request_id via findVerdictForRequest) to
--                    release its parked HTTP call — no SSE/ACK round-trip. The row is
--                    produced by the UNCHANGED tap-back path (orchestrator →
--                    resolveAttention); only the reader differs. No schema change.
-- attention_id is the attention this delivers the consequence of (NULL for a free
-- steer). delivered_at is set ONLY when the device ACKs injection (POST
-- /api/device/ack); the SSE stream serves rows WHERE delivered_at IS NULL and
-- re-serves until that ACK — at-least-once on the wire, deduped to once into the
-- session by the device. ONE column, ONE meaning (this replaces the old split of
-- decisions.delivered_at + session_messages.delivered_at/acked_at).
-- An INSERT here NOTIFYs 'session_inbox' to wake the device's event stream.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS session_inbox (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id    UUID        NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  account_id    UUID        NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  kind          TEXT        NOT NULL CHECK (kind IN ('reply', 'verdict')),
  -- reply: the text to inject. verdict: NULL.
  text          TEXT,
  -- verdict: the permission prompt to release + the decision. reply: both NULL.
  request_id    TEXT,
  behavior      TEXT        CHECK (behavior IN ('allow', 'deny')),
  -- The attention this resolves (NULL for a free steer). ON DELETE SET NULL so a
  -- pruned attention never drops a still-undelivered inbox row.
  attention_id  UUID        REFERENCES attention_events(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  delivered_at  TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_session_inbox_undelivered
  ON session_inbox(session_id) WHERE delivered_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_session_inbox_session_created
  ON session_inbox(session_id, created_at);

-- -----------------------------------------------------------------------------
-- message_log — durable record of inbound/outbound messages, account-scoped.
-- direction ∈ inbound|outbound. Used to build thread history for the orchestrator.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS message_log (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id  UUID        NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  direction   TEXT        NOT NULL CHECK (direction IN ('inbound', 'outbound')),
  body        TEXT        NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_message_log_account_created ON message_log(account_id, created_at DESC);
-- The "lost connection" reaper runs two inbound-only EXISTS subqueries per offline
-- device every ~10s (claimDevicesToNotifyLost: re-arm = an inbound newer than the lock;
-- suppress = an inbound within the active-conversation window). This partial index keeps
-- them index-only range scans as message_log grows (it skips the outbound half entirely).
CREATE INDEX IF NOT EXISTS idx_message_log_account_inbound_created
  ON message_log(account_id, created_at DESC) WHERE direction = 'inbound';

-- -----------------------------------------------------------------------------
-- processed_webhooks — idempotency ledger for inbound AgentPhone deliveries.
-- AgentPhone delivers at-least-once: a slow/failed ack (or a transient outage)
-- makes it retry the SAME message, and X-Webhook-ID is STABLE across those
-- retries. The webhook handler claims the id here (INSERT ... ON CONFLICT DO
-- NOTHING) BEFORE running the assistant turn — a losing claim means "already
-- seen", so the turn is skipped. Without this, every redelivery re-ran the turn
-- and the user got the same reply two-to-five times (the burst seen after a
-- recovery, each answering an older queued message).
--
-- Rows are tiny and append-only; ids are never re-checked once past the
-- provider's retry window, so prune rows older than a few days out of band if
-- the table ever grows.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS processed_webhooks (
  webhook_id  TEXT        PRIMARY KEY,                 -- X-Webhook-ID (stable across retries)
  seen_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- -----------------------------------------------------------------------------
-- turns — observability ledger: one row per orchestrator turn (assistant run).
-- The orchestrator is otherwise a black box: a "Read, no reply" could be the
-- model choosing silence, the turn erroring, a coalesce-abort, or a steer with
-- no user-facing text. Each turn records its OUTCOME so that's answerable with a
-- query instead of a guess.
--
-- One row per turn across all three triggers (a user message, an agent
-- attention, an agent status relay). `webhook_id` is the inbound delivery's
-- X-Webhook-ID (user turns only; NULL for device-triggered turns) — LEFT JOIN it
-- against processed_webhooks to spot a claimed delivery that produced NO turn row
-- (the process died mid-turn, e.g. a deploy). `id` is the turn uuid the
-- orchestrator generates, reused as the Langfuse trace_id so a row and its trace
-- line up.
--
-- Best-effort writes (the orchestrator inserts these detached) so an
-- observability blip never breaks a turn. Append-only + small; prune old rows
-- out of band like processed_webhooks.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS turns (
  id          UUID        PRIMARY KEY,                 -- per-turn uuid (also Langfuse trace_id)
  account_id  UUID        NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  session_id  UUID,                                    -- the agent session, when the turn is about one
  webhook_id  TEXT,                                    -- inbound X-Webhook-ID (user turns); join to processed_webhooks
  trigger     TEXT        NOT NULL,                    -- user_message | agent_event | agent_message
  outcome     TEXT        NOT NULL,                    -- replied | acted | silent | errored | aborted
  rounds      INT,                                     -- model rounds in the tool-calling loop
  tool_calls  INT,
  error       TEXT,                                    -- error message when outcome = errored
  latency_ms  INT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_turns_account_created ON turns(account_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_turns_outcome_created ON turns(outcome, created_at DESC);

-- -----------------------------------------------------------------------------
-- LEGACY delivery tables — replaced by session_inbox (above). Dropped here so a
-- re-apply of this schema cleans an already-provisioned DB. They held only
-- transient in-flight delivery state (verdicts/answers/steers), never durable
-- user data, so the drop is safe. CASCADE also removes their NOTIFY triggers; the
-- standalone trigger functions are dropped below (their CREATE statements are gone).
-- -----------------------------------------------------------------------------
DROP TABLE IF EXISTS decisions CASCADE;
DROP TABLE IF EXISTS session_messages CASCADE;
DROP FUNCTION IF EXISTS notify_decision_ready() CASCADE;
DROP FUNCTION IF EXISTS notify_session_message() CASCADE;
DROP FUNCTION IF EXISTS notify_decision_delivered() CASCADE;
DROP FUNCTION IF EXISTS notify_message_delivered() CASCADE;

-- =============================================================================
-- LISTEN/NOTIFY: wake the device's event stream when a session_inbox row lands.
-- On every INSERT this NOTIFYs 'session_inbox' with the session_id so the
-- per-session SSE stream re-queries that session's undelivered rows and flushes
-- them. Payload carries id + session_id + account_id.
-- =============================================================================
CREATE OR REPLACE FUNCTION notify_session_inbox() RETURNS trigger AS $$
BEGIN
  PERFORM pg_notify(
    'session_inbox',
    json_build_object(
      'id',         NEW.id,
      'session_id', NEW.session_id,
      'account_id', NEW.account_id
    )::text
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_session_inbox ON session_inbox;
CREATE TRIGGER trg_session_inbox
  AFTER INSERT ON session_inbox
  FOR EACH ROW
  EXECUTE FUNCTION notify_session_inbox();

-- =============================================================================
-- LISTEN/NOTIFY: delivery confirmation. When the device ACKs that it injected a
-- row (delivered_at flips null→set), NOTIFY 'inbox_delivered' with the row id so
-- the orchestrator's 30s confirmation watcher wakes promptly. Fires once, on the
-- null→set transition (the WHEN guard), so a re-ACK or any later UPDATE is inert.
-- =============================================================================
CREATE OR REPLACE FUNCTION notify_inbox_delivered() RETURNS trigger AS $$
BEGIN
  PERFORM pg_notify('inbox_delivered', json_build_object('id', NEW.id)::text);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_inbox_delivered ON session_inbox;
CREATE TRIGGER trg_inbox_delivered
  AFTER UPDATE OF delivered_at ON session_inbox
  FOR EACH ROW
  WHEN (OLD.delivered_at IS NULL AND NEW.delivered_at IS NOT NULL)
  EXECUTE FUNCTION notify_inbox_delivered();

-- =============================================================================
-- LISTEN/NOTIFY: wake BOTH the device's event stream AND the dashboard's event
-- stream when a session's lifecycle STATE changes (started, waiting, idle,
-- ended). afk is machine-wide and lives on `devices` now — it fires
-- `trg_device_state_update` (below), not this trigger. The control plane is the
-- single source of truth + SSE hub: on wake the device re-queries its session
-- and the dashboard re-queries the account's live sessions/devices. The payload
-- carries session_id (device, session-keyed) AND account_id (dashboard-keyed).
--
-- Two triggers, deliberately: the UPDATE trigger's WHEN fires ONLY on a real
-- state change — NOT on the per-60s touchSession() that only bumps last_event_at
-- (which would otherwise wake the device every heartbeat). The INSERT trigger
-- always fires so a newly-started session appears live in the dashboard. (A
-- single AFTER INSERT OR UPDATE trigger can't be used here: a WHEN clause may
-- not reference OLD on the INSERT path.)
-- =============================================================================
CREATE OR REPLACE FUNCTION notify_session_state() RETURNS trigger AS $$
BEGIN
  PERFORM pg_notify(
    'session_state',
    json_build_object(
      'session_id', NEW.id,
      'account_id', NEW.account_id
    )::text
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_session_state_insert ON sessions;
CREATE TRIGGER trg_session_state_insert
  AFTER INSERT ON sessions
  FOR EACH ROW
  EXECUTE FUNCTION notify_session_state();

DROP TRIGGER IF EXISTS trg_session_state_update ON sessions;
CREATE TRIGGER trg_session_state_update
  AFTER UPDATE ON sessions
  FOR EACH ROW
  -- Only on a lifecycle (state) change. afk moved to `devices` (machine-wide) and
  -- fires `trg_device_state_update` instead; the vestigial sessions.afk column is
  -- no longer written, so it's not watched here.
  WHEN (OLD.state IS DISTINCT FROM NEW.state)
  EXECUTE FUNCTION notify_session_state();

-- =============================================================================
-- LISTEN/NOTIFY: a device's afk changed (the machine-wide toggle). Wakes
-- BOTH every live SSE stream for that device (each re-queries its session's now
-- device-sourced {afk} and pushes a `state` event to its PreToolUse hook)
-- AND the dashboard's account stream (re-render the device cards). A device
-- change has no single session_id, so it rides its OWN channel (device_state)
-- carrying device_id + account_id — keeping the session_state fan-out clean.
-- =============================================================================
CREATE OR REPLACE FUNCTION notify_device_state() RETURNS trigger AS $$
BEGIN
  PERFORM pg_notify(
    'device_state',
    json_build_object(
      'device_id', NEW.id,
      'account_id', NEW.account_id
    )::text
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_device_state_update ON devices;
CREATE TRIGGER trg_device_state_update
  AFTER UPDATE ON devices
  FOR EACH ROW
  WHEN (OLD.afk IS DISTINCT FROM NEW.afk)
  EXECUTE FUNCTION notify_device_state();

-- -----------------------------------------------------------------------------
-- session_activity — the AFK transcript tap. A lightweight, per-block stream of
-- what a Claude Code session is DOING (user messages, assistant replies, tool
-- call markers, failed tool results) so the orchestrator can answer "what's my
-- session up to?". The device ships these ONLY while AFK; tool inputs are reduced
-- to a one-line `summary`, tool results carry NO content (only is_error), and
-- thinking blocks are dropped — never the full transcript data.
--
-- kind ∈ user_message|assistant_text|tool_use|tool_result.
-- (line_no, block_idx) is the transcript position (line_no is a monotonic
-- per-session event index, block_idx the block within that line): UNIQUE per
-- session so a device re-read after a crash (before its byte cursor committed)
-- de-dupes via ON CONFLICT DO NOTHING rather than double-inserting. Also the
-- canonical ORDER for the orchestrator's trail (insert time can reorder on
-- retry). No NOTIFY trigger — pull-only context read at turn time.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS session_activity (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id  UUID        NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  account_id  UUID        NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  device_id   UUID        NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  line_no     INTEGER     NOT NULL,
  block_idx   INTEGER     NOT NULL,
  kind        TEXT        NOT NULL
                CHECK (kind IN ('user_message', 'assistant_text', 'tool_use', 'tool_result')),
  tool_name   TEXT,
  summary     TEXT,
  body        TEXT,                                 -- message text (NULL for tool markers)
  is_error    BOOLEAN     NOT NULL DEFAULT false,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (session_id, line_no, block_idx)
);
-- "recent N for this session" (orchestrator turn context), ordered by transcript
-- position (line_no, block_idx) — matches recentSessionActivity's ORDER BY.
CREATE INDEX IF NOT EXISTS idx_session_activity_recent
  ON session_activity(session_id, line_no DESC, block_idx DESC);
CREATE INDEX IF NOT EXISTS idx_session_activity_account ON session_activity(account_id);

-- -----------------------------------------------------------------------------
-- Ephemeral cleanup: session_activity exists ONLY while a device is AFK. When AFK
-- flips OFF, wipe every row for that device's sessions immediately — the user is
-- back at the keyboard, the orchestrator no longer needs the history, and the
-- durable record is the local transcript on the machine (never uploaded raw).
--
-- Server-side (a trigger) so it fires no matter WHO flips afk to 'off': the device's
-- POST /api/device/state, OR a dashboard toggle (which UPDATEs devices directly).
-- The device is never trusted to delete. The narrow window where an in-flight
-- activity POST lands just after the wipe is closed by insertSessionActivity's
-- `AND d.afk = 'on'` guard (an insert racing afk-off matches zero rows).
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION wipe_session_activity_on_afk_off() RETURNS trigger AS $$
BEGIN
  DELETE FROM session_activity WHERE device_id = NEW.id;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_wipe_session_activity_afk_off ON devices;
CREATE TRIGGER trg_wipe_session_activity_afk_off
  AFTER UPDATE ON devices
  FOR EACH ROW
  WHEN (OLD.afk = 'on' AND NEW.afk = 'off')
  EXECUTE FUNCTION wipe_session_activity_on_afk_off();

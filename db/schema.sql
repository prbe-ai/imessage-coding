-- =============================================================================
-- imessage-coding — Neon Postgres schema
--
-- Stateless app tier: ALL state lives here. Everything is account-scoped.
-- The control plane wakes long-polls via a LISTEN/NOTIFY trigger on decisions.
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
  phone_number  TEXT        NOT NULL UNIQUE,        -- E.164, e.g. +16576263011
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
  disabled_at        TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_devices_account ON devices(account_id);

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
-- state ∈ active|waiting|idle|ended ; afk ∈ on|off ; grant ∈ off|edits|full
-- (string-checked here to match @imsg/shared const-objects).
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sessions (
  id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  device_id      UUID        NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  account_id     UUID        NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  cwd            TEXT,
  agent          TEXT        NOT NULL DEFAULT 'claude-code',
  state          TEXT        NOT NULL DEFAULT 'active'
                   CHECK (state IN ('active', 'waiting', 'idle', 'ended')),
  afk            TEXT        NOT NULL DEFAULT 'off'
                   CHECK (afk IN ('on', 'off')),
  "grant"        TEXT        NOT NULL DEFAULT 'off'
                   CHECK ("grant" IN ('off', 'edits', 'full')),
  last_event_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_sessions_account ON sessions(account_id);
CREATE INDEX IF NOT EXISTS idx_sessions_device  ON sessions(device_id);

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
-- decisions — the resolution of an attention_event.
-- behavior ∈ allow|deny (permissions) ; grant ∈ off|edits|full (escalation)
-- source ∈ phone|dashboard|keyboard|timeout (timeout is always fail-closed).
-- An INSERT here NOTIFYs 'decision_ready' to wake the device long-poll.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS decisions (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  attention_id  UUID        NOT NULL REFERENCES attention_events(id) ON DELETE CASCADE,
  behavior      TEXT        CHECK (behavior IN ('allow', 'deny')),
  answer_text   TEXT,
  "grant"       TEXT        CHECK ("grant" IN ('off', 'edits', 'full')),
  source        TEXT        NOT NULL
                  CHECK (source IN ('phone', 'dashboard', 'keyboard', 'timeout')),
  resolved_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Set once the device ACKs that it injected this decision into the session
  -- (POST /api/device/ack). The SSE stream only serves decisions where this is
  -- NULL, so a resolved answer/verdict is delivered at-least-once but never
  -- re-injected on reconnect/restart (was the duplicate-reply loop). Mirrors
  -- session_messages.delivered_at.
  delivered_at  TIMESTAMPTZ
);
-- Idempotent add for already-provisioned DBs (CREATE TABLE IF NOT EXISTS above
-- is a no-op once the table exists).
ALTER TABLE decisions ADD COLUMN IF NOT EXISTS delivered_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_decisions_attention ON decisions(attention_id);
-- Hot path: the SSE flush queries undelivered decisions per session.
CREATE INDEX IF NOT EXISTS idx_decisions_undelivered
  ON decisions(attention_id) WHERE delivered_at IS NULL;

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
-- session_messages — free-text steering pushed INTO a running coding-agent
-- session by the assistant ("also add tests"). Distinct from decisions (which
-- resolve a pending attention): a steer has no attention to resolve. The device
-- drains undelivered rows over its event stream and injects them into the
-- session as <channel> messages; delivered_at marks consumption.
-- An INSERT here NOTIFYs 'session_message' to wake the device's event stream.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS session_messages (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id    UUID        NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  account_id    UUID        NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  body          TEXT        NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  delivered_at  TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_session_messages_undelivered
  ON session_messages(session_id) WHERE delivered_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_session_messages_session_created
  ON session_messages(session_id, created_at);

-- =============================================================================
-- LISTEN/NOTIFY: wake a waiting control-plane long-poll when a decision lands.
--
-- The device API's GET /api/device/decisions long-poll runs LISTEN
-- 'decision_ready'. On every decisions INSERT this trigger NOTIFYs with a JSON
-- payload carrying the attention_id (and the session it belongs to) so the
-- waiter can re-query only the relevant session's resolved decisions.
-- =============================================================================
CREATE OR REPLACE FUNCTION notify_decision_ready() RETURNS trigger AS $$
DECLARE
  v_session_id UUID;
  v_account_id UUID;
BEGIN
  SELECT ae.session_id, ae.account_id
    INTO v_session_id, v_account_id
    FROM attention_events ae
   WHERE ae.id = NEW.attention_id;

  PERFORM pg_notify(
    'decision_ready',
    json_build_object(
      'decision_id',  NEW.id,
      'attention_id', NEW.attention_id,
      'session_id',   v_session_id,
      'account_id',   v_account_id
    )::text
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_decision_ready ON decisions;
CREATE TRIGGER trg_decision_ready
  AFTER INSERT ON decisions
  FOR EACH ROW
  EXECUTE FUNCTION notify_decision_ready();

-- =============================================================================
-- LISTEN/NOTIFY: wake the device's event stream when a free-text steer lands.
-- Payload carries the session_id so the stream re-queries only that session's
-- undelivered session_messages.
-- =============================================================================
CREATE OR REPLACE FUNCTION notify_session_message() RETURNS trigger AS $$
BEGIN
  PERFORM pg_notify(
    'session_message',
    json_build_object(
      'message_id', NEW.id,
      'session_id', NEW.session_id,
      'account_id', NEW.account_id
    )::text
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_session_message ON session_messages;
CREATE TRIGGER trg_session_message
  AFTER INSERT ON session_messages
  FOR EACH ROW
  EXECUTE FUNCTION notify_session_message();

-- =============================================================================
-- LISTEN/NOTIFY: wake BOTH the device's event stream AND the dashboard's event
-- stream when a session's afk/grant/state changes — whoever wrote it (the
-- dashboard's account-scoped UPDATE, the CLI's device-wide UPDATE, or a
-- lifecycle transition). The control plane is the single source of truth + SSE
-- hub: on wake the device re-queries its session's {afk,grant} and pushes a
-- `state` event (so the PreToolUse hook honors a dashboard toggle), and the
-- dashboard re-queries the account's live sessions and pushes a `sessions` event.
-- The payload carries session_id (device, session-keyed) AND account_id
-- (dashboard, account-keyed).
--
-- Two triggers, deliberately: the UPDATE trigger's WHEN fires ONLY on a real
-- afk/grant/state change — NOT on the per-60s touchSession() that only bumps
-- last_event_at (which would otherwise wake the device every heartbeat). The
-- INSERT trigger always fires so a newly-started session appears live in the
-- dashboard. (A single AFTER INSERT OR UPDATE trigger can't be used here: a WHEN
-- clause may not reference OLD on the INSERT path.)
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
  WHEN (
    OLD.afk     IS DISTINCT FROM NEW.afk
    OR OLD."grant" IS DISTINCT FROM NEW."grant"
    OR OLD.state   IS DISTINCT FROM NEW.state
  )
  EXECUTE FUNCTION notify_session_state();

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

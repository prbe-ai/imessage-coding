/**
 * Server-side mapping of `sessions` DB rows to the shared `SessionInfo` wire
 * shape. The column CHECK constraints in db/schema.sql mirror the @imsg/shared
 * const-objects, so DB values are valid enum members — the validators here are
 * a defense-in-depth guard against drift rather than a parse step.
 *
 * Server-only.
 */

import "server-only";

import {
  AfkState,
  AgentKind,
  SessionState,
  isAfkState,
  isSessionState,
  isAgentKind,
  type SessionInfo,
} from "@imsg/shared";

/** Raw shape selected from the `sessions` table. */
export interface SessionDbRow {
  id: string;
  device_id: string;
  cwd: string | null;
  title: string | null;
  agent: string;
  last_event_at: string;
  state: string;
  afk: string;
}

/** Convert a DB row to the shared `SessionInfo`, clamping any unexpected enum
 *  value to its safe default (never throws — a single bad row shouldn't blank
 *  the whole list). */
export function toSessionInfo(row: SessionDbRow): SessionInfo {
  const info: SessionInfo = {
    id: row.id,
    deviceId: row.device_id,
    agent: isAgentKind(row.agent) ? row.agent : AgentKind.CLAUDE_CODE,
    lastEventAt: row.last_event_at,
    state: isSessionState(row.state) ? row.state : SessionState.IDLE,
    afk: isAfkState(row.afk) ? row.afk : AfkState.OFF,
  };
  if (row.cwd) info.cwd = row.cwd;
  if (row.title) info.title = row.title;
  return info;
}

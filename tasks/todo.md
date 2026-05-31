# Device-package P1 review fixes + cross-cutting contracts

## Fix A — Hook matcher vs grant lockstep (device)
- [ ] hooks/hooks.json: broaden PreToolUse matcher 'AskUserQuestion|ExitPlanMode' -> '*'
- [ ] hooks/intercept.ts: make session-grant block correct + safe
  - grant=full -> allow ALL tools
  - grant=edits -> allow ONLY Edit|Write|MultiEdit|NotebookEdit; Bash/others fall through
  - applies regardless of AFK; non-edit tools NEVER auto-allowed except grant=full
- [ ] intercept.ts header/docstring: match what actually fires (drop the false '...|*' claim that wasn't registered; now '*' IS registered)

## Fix B — CLI state sync (device)
- [ ] cli.ts syncState(): POST {afk,grant} with NO sessionId (device-wide), treat 2xx as success
  (already omits sessionId — verify + confirm classification handling)

## Fix C — install.sh sh-pipe safety
- [ ] Resolve SCRIPT_DIR / control-plane URL without BASH_SOURCE (empty under | sh)

## Contract #1 — GRANT SOURCE LOCKDOWN (control plane)
- [ ] orchestrator validateAction: cap LLM-originated grant at EDITS (strip FULL)

## Contract #2 — DEVICE-WIDE STATE (control plane)
- [ ] POST /api/device/state: sessionId OPTIONAL; when omitted apply to ALL device's live sessions
- [ ] GET /api/device/state: return {enabled, afk, grant} for the device
- [ ] repo: device-wide session-state update + device aggregate read helpers

## Verify
- [x] tsc-clean across device + control-plane (no bun install)

## Review
- A/B/C (device): DONE. hooks.json matcher -> "*"; intercept grant block + header
  fixed; cli syncState device-wide (no sessionId) + 2xx==success; install.sh
  POSIX-sh-safe (set -eu, no BASH_SOURCE, IMSG_DEVICE_SRC required under | sh).
- Contracts #1 + #2 (control plane) were ALREADY implemented by the parallel
  control-plane agent (validateAction caps FULL->EDITS; POST optional sessionId
  device-wide via updateSessionStateForDevice; GET returns {enabled,afk,grant}
  via getDeviceState). Left untouched — verified they match my device side.
- tsc --noEmit: device EXIT=0, control-plane EXIT=0. hooks.json valid JSON.
  install.sh: sh -n + dash -n both pass.
</content>
</invoke>

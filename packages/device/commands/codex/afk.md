---
description: Toggle AFK (away-from-keyboard) mode — route Codex destructive-tool approvals and questions to your phone over iMessage.
---

# /afk

Toggle AFK (away-from-keyboard) mode for the imsg-device bridge.

AFK on routes Codex destructive-tool approvals and questions to the user's phone
over iMessage (approve / deny / answer by text); AFK off keeps them local at the
keyboard.

## Workflow

1. Run this exact shell command (it flips the machine-wide AFK state and mirrors
   it to the control plane):

   ```
   bun "${CLAUDE_PLUGIN_ROOT}/bin/imsg.ts" afk toggle
   ```

2. Reply with ONLY the new AFK state the command printed (e.g. `afk: on`),
   nothing else.

## Notes

- AFK state is machine-wide and shared with any Claude Code sessions on this
  machine (one `~/.imsg/afk.state`).
- Unlike Claude Code, Codex has no `!`-exec slash command, so this command is a
  prompt that asks the agent to run the toggle CLI. Toggling at the keyboard
  (AFK currently off) runs locally; toggling while AFK is on may surface the
  shell approval to your phone first — approve it to complete the toggle.

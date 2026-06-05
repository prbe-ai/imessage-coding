---
name: afk
description: Toggle AFK (away-from-keyboard) mode for the imsg-device iMessage bridge. Use whenever the user wants to toggle AFK, go AFK, come back from AFK, or set AFK on/off — this routes (or stops routing) Codex tool-approvals and questions to the user's phone over iMessage. Invoke with $afk.
---

# AFK toggle

To toggle AFK, run EXACTLY this command and nothing else (it flips the machine-wide
AFK state in `~/.imsg/afk.state`, shared with Claude Code, and mirrors the new value
to the control plane):

```bash
bun "${CLAUDE_PLUGIN_ROOT}/bin/imsg.ts" afk toggle
```

Then reply with ONLY the new AFK state the command printed (e.g. `afk: on`), nothing else.

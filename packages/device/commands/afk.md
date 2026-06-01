---
description: Toggle AFK mode for the imsg-device channel. AFK on routes Claude Code permission prompts and questions to your phone over iMessage; AFK off keeps them local. Invoke as /imsg-device:afk.
disable-model-invocation: true
allowed-tools: Bash(bun *)
---

Toggling AFK for imsg-device:

```!
bun "${CLAUDE_PLUGIN_ROOT}/bin/imsg.ts" afk toggle
```

The line above is the new state: `afk: on` routes permission prompts and questions to your phone; `afk: off` keeps everything local. Just report it back to me — nothing else to do.

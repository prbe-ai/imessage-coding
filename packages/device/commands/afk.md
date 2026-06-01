---
description: Toggle AFK mode for the imsg-device channel. AFK on routes Claude Code permission prompts and questions to your phone over iMessage; AFK off keeps them local. Invoke as /imsg-device:afk.
disable-model-invocation: true
allowed-tools: Bash(bun *)
---

```!
bun "${CLAUDE_PLUGIN_ROOT}/bin/imsg.ts" afk toggle
```

Reply with only the new AFK state shown above (e.g. `afk: on`), nothing else.

---
description: Stop the running Telegram broker daemon.
disable-model-invocation: true
---

# Stop the Telegram broker

Find the broker process and terminate it:

```bash
pkill -f "tsx.*src/index.ts"
```

Send `SIGTERM`, not `SIGKILL`: the broker handles it, closes each live Claude
session cleanly, and stops polling Telegram. Confirm it is gone with
`pgrep -af "tsx.*src/index.ts"` and report the result.

Stopping the broker does not destroy anything. Session transcripts live on disk
under `~/.claude/projects`, and the topic-to-session registry survives, so the
next `/telegram-broker:start` resumes each topic where it left off.

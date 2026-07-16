---
description: Arm this session to receive messages from a Telegram topic that is watching it, via the claude-telegram-broker.
disable-model-invocation: true
---

# Arm the Telegram watch

Run this **inside the session you want to reach from Telegram**, after running
`/watch <session-id>` in the Telegram topic.

The session id to arm is given as the argument. If none was given, use this
session's own id.

## What to do

Arm exactly one persistent Monitor:

- **command**: `<plugin-root>/node_modules/.bin/tsx <plugin-root>/scripts/mirror/poller.ts <session-id>`
- **description**: `Telegram messages for <short-id>`
- **persistent**: `true`

`<plugin-root>` is `${CLAUDE_PLUGIN_ROOT}` when installed as a plugin, otherwise
the repo checkout.

**Arm it once.** If a Monitor for this exact command is already running in this
session, say so and stop — two pollers would both be touching the same heartbeat
and racing for the same messages. Delivery survives that race (claiming a message
is an atomic rename, so only one poller can win each one), but the second poller
buys nothing and makes the logs a puzzle.

## What arriving messages look like

Each event is one JSON line:

```json
{"from":"telegram","text":"what did you conclude about the retry logic?","at":"2026-07-16T10:22:31.004Z"}
```

Treat the `text` as a message from the user — because it is one; they are just
typing from their phone instead of the keyboard. Answer it in this session,
normally. The reply is mirrored back to their Telegram topic automatically by the
`Stop` hook, so do not try to send it yourself.

Messages arrive on their own schedule, including while you are idle or waiting on
a question. That is expected.

## Stopping

`TaskStop` on the Monitor, or just end the session — the watch is only armed for
this session's lifetime. The broker notices within about five seconds (the
heartbeat goes stale) and starts refusing messages for that topic rather than
running anything behind your back.

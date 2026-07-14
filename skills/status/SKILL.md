---
description: Report whether the Telegram broker is running, and diagnose it against the Telegram API if it is not working.
disable-model-invocation: true
---

# Telegram broker status

Report the broker's health. Work through these and summarise the outcome:

1. **Is it running?** `pgrep -af "tsx.*src/index.ts"`. If nothing matches, say so
   and point at `/telegram-broker:start`.

2. **What does the log say?** Read the tail of `/tmp/claude-telegram-broker.log`.
   The startup checks report the group, privacy mode, and topic permissions.

3. **Which sessions exist?** Read `~/.claude-telegram-broker.json` (or
   `BROKER_STATE_FILE` if set). It maps each Telegram topic to a Claude session id
   and working directory.

4. **If Telegram itself looks wrong**, ask it directly rather than guessing.
   Load the token from `${CLAUDE_PLUGIN_ROOT}/.env` into a shell variable — never
   echo it — and check:

   ```bash
   # Privacy mode: can_read_all_group_messages must be true, or the bot never
   # receives ordinary group messages and topics look dead with no error.
   curl -s "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/getMe"

   # The group must exist, be a forum, and the bot must be an admin with
   # can_manage_topics. Supergroup ids are negative (-100…); a missing minus
   # sign yields "chat not found".
   curl -s "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/getChat?chat_id=$TELEGRAM_GROUP_ID"
   ```

   Do **not** call `getUpdates` while the broker is running — Telegram allows one
   consumer per token, and you would steal the messages meant for it.

Say which of these is actually broken. Do not report "looks fine" unless every
check passed.

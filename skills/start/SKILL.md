---
description: Start the Telegram broker daemon in the background and report whether it came up healthy.
disable-model-invocation: true
---

# Start the Telegram broker

The broker is a long-lived process that lives **outside** any Claude Code
session — it supervises sessions, so it cannot run inside one. This skill starts
it in the background and checks it came up.

Do this:

1. Treat `${CLAUDE_PLUGIN_ROOT}` as the project directory. If it has no
   `node_modules`, install dependencies there first (`pnpm install`, falling back
   to `npm install`).

2. If `${CLAUDE_PLUGIN_ROOT}/.env` does not exist, stop and tell the user to copy
   `.env.example` to `.env` and fill in `TELEGRAM_BOT_TOKEN`,
   `TELEGRAM_ALLOWED_USERS` and `TELEGRAM_GROUP_ID`. Do not invent values, and
   never print the contents of `.env` — it holds a bot token.

3. If a broker is already running (`pgrep -f "tsx.*src/index.ts"`), say so and
   stop. Two brokers on one bot token fight over `getUpdates` and Telegram will
   reject one of them with a 409.

4. Start it detached, with its output going to a log file:

   ```bash
   cd "${CLAUDE_PLUGIN_ROOT}" && nohup pnpm start > /tmp/claude-telegram-broker.log 2>&1 &
   ```

5. Wait a few seconds, then read the log and report what it says. The startup
   checks are the point — surface them verbatim rather than summarising:

   - `[telegram] group OK: forum + Manage Topics.` — everything is ready.
   - `privacy mode is ON` — the bot cannot see ordinary group messages. It has to
     be disabled in @BotFather **and the bot re-added to the group**.
   - `the bot is "member" ... without Manage Topics` — promote it to admin.
   - `cannot reach group` — wrong id, or the bot is not a member.

Report the log path so the user can follow it themselves.

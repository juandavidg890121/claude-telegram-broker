---
description: Configure the Telegram broker for the first time — walk the user through an interactive setup that writes .env and installs the /watch hooks.
disable-model-invocation: true
---

# Set up the Telegram broker

There is an interactive installer that does the whole configuration: it
validates the bot token against Telegram, discovers the user's id and group id
by watching for a message, and merges the `/watch` hooks into
`~/.claude/settings.json` with a backup. At the end it asks whether to write the
config to a `.env` file or print it as shell `export` commands — the export form
detects Windows vs POSIX and prints the right syntax (`export`, `$env:`, or
`set`).

It is interactive — it reads a hidden token and waits for the user to send
Telegram messages — so it needs a real terminal. **Do not try to run it through
your Bash tool and answer its prompts yourself.** Instead:

1. Tell the user to run this in their own terminal:

   ```bash
   cd "${CLAUDE_PLUGIN_ROOT}" && pnpm install && pnpm setup
   ```

   (If they don't have `pnpm`, `npm install && npx tsx scripts/setup.ts` works.)

2. Tell them what it will ask for, so nothing is a surprise:
   - **A bot token** from [@BotFather](https://t.me/BotFather) — `/newbot`, then
     `/setprivacy` → the bot → **Disable** so it can read group messages.
   - **A DM to the bot** so it can learn their user id automatically.
   - **Optionally a forum group** (Topics enabled, bot added as admin with
     *Manage Topics*) for the one-topic-per-session workflow. Skipping it runs
     the broker in a single chat instead.
   - **Optionally voice notes**: if they say yes, it downloads a whisper model
     into a directory they choose and reports whether the whisper.cpp binary and
     ffmpeg are present, pointing at how to get whichever is missing. The model
     download can be large (148 MB and up), so they'll want a decent connection.
   - Every answer is validated as they go, and required fields can't be skipped:
     press Enter past one three times and setup stops rather than write a broken
     config.

3. The token is a secret and grants control of the bot; the allowlist grants
   running commands on this machine. The installer keeps the token out of the
   terminal scrollback and out of this conversation — which is exactly why it
   runs in their terminal and not here. Do not ask them to paste the token to
   you.

When it finishes, `/telegram-broker:start` launches the daemon.

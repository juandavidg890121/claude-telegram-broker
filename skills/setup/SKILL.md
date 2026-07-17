---
description: Configure the Telegram broker for the first time — build the plugin and launch its interactive installer so the user completes setup in their own terminal.
disable-model-invocation: true
---

# Set up the Telegram broker

There is an interactive installer (`scripts/setup.ts`, the `configure` script)
that does the whole configuration: it validates the bot token against Telegram,
discovers the user's id and group id by watching for a message they send,
optionally downloads a whisper model for voice notes, writes the config, and
merges the `/watch` hooks into `~/.claude/settings.json` with a backup.

It reads from the terminal directly (via `/dev/tty` when its stdin isn't one),
so it can prompt the user even when you launch it. Do this:

## 1. Build, then launch it

Run these from the plugin root (`${CLAUDE_PLUGIN_ROOT}`), the second one in the
**foreground with a long timeout** — the user will be answering prompts in their
terminal while it runs:

```bash
cd "${CLAUDE_PLUGIN_ROOT}" && pnpm install
```

```bash
cd "${CLAUDE_PLUGIN_ROOT}" && pnpm configure
```

- Use `pnpm configure`, **never** `pnpm setup` — `setup` is a built-in pnpm
  command (it edits the user's shell profile) and would run instead of ours.
- If `pnpm` is missing: `npm install` then `npx tsx scripts/setup.ts`.
- The installer talks to the user's real terminal, so its prompts appear there,
  not in your output. Wait for it to exit; don't try to answer for it.

**If the prompts don't show up in the user's terminal** (some environments keep
the terminal attached to the agent), tell them to run it themselves — the build
is already done:

```bash
cd "${CLAUDE_PLUGIN_ROOT}" && pnpm configure
```

## 2. Tell them what it will ask for

So nothing mid-run is a surprise:

- **A bot token** from [@BotFather](https://t.me/BotFather) — `/newbot`, then
  `/setprivacy` → the bot → **Disable** so it can read group messages.
- **A DM to the bot** so it can learn their user id automatically.
- **Optionally a forum group** (Topics enabled, bot added as admin with *Manage
  Topics*) for the one-topic-per-session workflow. Skipping it runs the broker
  in a single chat instead.
- **Optionally voice notes**: it downloads a whisper model (148 MB and up) into a
  directory they choose and reports whether `whisper.cpp` and `ffmpeg` are
  present.
- At the end, whether to write a `.env` file or print shell `export` commands.

Required fields can't be skipped: pressing Enter past one three times stops
setup rather than writing a broken config.

## 3. Don't handle the token yourself

The bot token grants control of the bot; the allowlist grants running commands
on this machine. The installer reads the token hidden and keeps it out of both
the terminal scrollback and this conversation — that is the whole reason it
prompts in the terminal rather than through you. Do not ask the user to paste
the token to you, and do not read it from `.env` afterwards.

When it finishes, `/telegram-broker:start` launches the daemon.

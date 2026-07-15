# Privacy

This plugin runs entirely on your own machine. Its authors operate no server,
receive no data from it, and add no telemetry or analytics.

## What the plugin stores, and where

Everything is local to the machine you run it on:

- **Your bot token and allowlist** live in a `.env` file (or in your shell
  environment) that you create. They are never transmitted anywhere except to
  Telegram, to operate your own bot.
- **The session registry** (which Telegram topic maps to which Claude Code
  session) is a JSON file in your home directory
  (`~/.claude-telegram-broker.json` by default).
- **Session transcripts** are the ones Claude Code already keeps under
  `~/.claude/projects`. The plugin reads them; it does not copy or upload them.

None of this is sent to the plugin's authors. There is no account to create and
no backend to phone home to.

## Third parties your messages pass through

The plugin is a bridge, so the messages you exchange do travel through services
you are already choosing to use:

- **Telegram** carries every message between your phone and the broker. Your use
  of Telegram is governed by the [Telegram Privacy Policy](https://telegram.org/privacy).
- **Claude Code / Anthropic** processes the prompts and produces the responses,
  exactly as it would if you were typing them in a terminal. This is governed by
  [Anthropic's privacy policy](https://www.anthropic.com/legal/privacy).

The plugin does not add any additional collection, sharing, or storage on top of
those two.

## Access control

Only Telegram user IDs you list in `TELEGRAM_ALLOWED_USERS` can send messages to
the broker or approve tool calls. Everyone else is dropped. You control that list.

## Contact

Questions about this document: open an issue at
https://github.com/juandavidg890121/claude-telegram-broker/issues

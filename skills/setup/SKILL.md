---
description: Configure the Telegram broker for the first time — conduct the setup interview in the conversation, then apply it non-interactively so it works even in editors where the installer can't reach a terminal.
disable-model-invocation: true
---

# Set up the Telegram broker

The installer (`scripts/setup.ts`) has two modes. Run it directly and it's
interactive. Launched by you in most editor environments there is no terminal it
can prompt through, so you drive it a different way: **collect the answers in
this conversation, write them to a plan file, and apply them non-interactively**.

Before starting, say this once, plainly: the bot token will pass through this
conversation, because you need it to apply the config. That is the trade for
doing setup here instead of in a terminal. If the user would rather keep the
token out of the chat entirely, they run `pnpm configure` themselves in a
terminal and you stop here.

## 1. Build

```bash
cd "${CLAUDE_PLUGIN_ROOT}" && pnpm install
```

## 2. Interview — one thing at a time, in the chat

Ask for each of these. Validate as you go using plain HTTP (`curl`), so a wrong
answer is caught now.

1. **Bot token.** From [@BotFather](https://t.me/BotFather): `/newbot`, then
   `/setprivacy` → the bot → **Disable**. Validate it:
   `curl -s "https://api.telegram.org/bot<TOKEN>/getMe"` — `"ok":true` and a
   `"username"` means it's good; show the username. Re-ask on failure.

2. **Their Telegram user id.** Ask them to send the bot any message, then read it
   off `curl -s "https://api.telegram.org/bot<TOKEN>/getUpdates"` — the `from.id`
   of a `private` chat message. Confirm it back. (Ask for extra allowed ids if
   they want any; everyone allowed can approve tool calls, i.e. run commands on
   this machine.)

3. **Group id (optional).** For one-topic-per-session: they make a forum group
   (Topics on), add the bot as admin with *Manage Topics*, post a message; read
   the `chat.id` (a `group`/`supergroup`, starts with `-100`) from `getUpdates`.
   Skipping it runs the broker in a single chat.

4. **Working directory** `/new` starts sessions in — default is their home.
   **Model** for new sessions — default is Claude Code's own. Enter/skip accepts
   the default for each; only record a value they actually chose.

5. **Permission mode** (optional): one of `default`, `acceptEdits`, `plan`,
   `dontAsk`, `bypassPermissions`. **Voice notes** (optional): if yes, ask which
   whisper model (`base` 148 MB, `small`, `large-v3-turbo`, `large-v3`) and which
   directory to install into — apply will download it.

6. **Where the config goes:** a `.env` file (default) or printed shell `export`
   commands (`output: "export"`, with `shell` = `posix`/`powershell`/`cmd`).

## 3. Apply

Write the answers to a plan file and hand it to the installer. It validates every
field again, does the writing/downloading/hook-merge, and **deletes the plan file
itself** (it holds the token):

```bash
cat > /tmp/broker-plan.json <<'JSON'
{
  "token": "…",
  "allowedUsers": ["123456789"],
  "groupId": "-1001234567890",
  "defaultCwd": null,
  "model": null,
  "permissionMode": null,
  "whisper": null,
  "output": "env",
  "installHooks": true
}
JSON
cd "${CLAUDE_PLUGIN_ROOT}" && pnpm configure --apply /tmp/broker-plan.json
```

Omit or `null` the optional fields the user didn't set. For voice notes, set
`"whisper": { "model": "base", "dir": "/path/they/chose", "language": "auto" }`.

If apply reports a validation error, fix that one answer with the user and re-run
— don't rewrite the others.

## 4. After

Don't read the token back out of `.env`, and don't echo it. When it's done,
`/telegram-broker:start` launches the daemon.

## The manual alternative

If the user prefers, everything above is a single interactive command they run in
their own terminal — `cd "${CLAUDE_PLUGIN_ROOT}" && pnpm configure` — which keeps
the token off the chat entirely. (Note: `pnpm configure`, not `pnpm setup` —
`setup` is a built-in pnpm command.)

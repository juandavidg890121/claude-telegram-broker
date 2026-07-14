# claude-telegram-broker

Drive Claude Code sessions from Telegram: create sessions, talk to them, list
them, read their history, and approve tool calls from your phone — while the
work happens on your machine, against your real files.

## Why a broker

Two constraints shape the design:

1. **Telegram allows one `getUpdates` consumer per bot token.** Two pollers on
   the same token fight (`409 Conflict`), so exactly one long-lived process must
   own the token. That process is the broker.
2. **A Claude Code *channel* plugin cannot manage sessions.** Channels are MCP
   servers that Claude Code spawns over stdio: they die with their session and
   can only push events into the session they belong to. Session management has
   to live *above* the sessions.

So the broker owns the token and the sessions, and Telegram is just a frontend.
It uses the [Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk), not
the channels research preview, so it doesn't depend on a protocol the docs warn
may change.

```
Telegram ──getUpdates──▶ broker ──query()──▶ Claude session (topic #1)
            sendMessage ◀──┤  registry  └──▶ Claude session (topic #2)
                           └─ canUseTool ──▶ inline Allow/Deny buttons
```

**One Telegram forum topic = one Claude session.** The `message_thread_id` that
every Telegram message already carries is the routing key, so there is no
"switch session" command to invent.

## Setup

1. Create a bot with [@BotFather](https://t.me/BotFather) and copy the token.
2. **Turn privacy mode off**: `/setprivacy` → pick your bot → **Disable**. Then
   **remove the bot from the group and add it back** — the change only takes
   effect on re-join. With privacy on, Telegram never delivers ordinary group
   messages to the bot, so topics look dead with no error anywhere.
3. Create a Telegram **group with Topics enabled** and add the bot as admin with
   *Manage Topics*. Put its id in `TELEGRAM_GROUP_ID` — this is what makes
   `/new` able to open a topic per session.

   To find the id: start the broker and send `/help` in the group. Commands get
   through even under privacy mode, and the broker logs
   `[telegram] from <you> chat=-100… topic=…`. That `chat=-100…` is the id.
4. Configure and run:

```bash
cp .env.example .env    # fill in token, your user id, group id
pnpm install
pnpm start
```

Get your numeric user id from [@userinfobot](https://t.me/userinfobot). `pnpm start`
reads `.env` if it's there; every setting is a plain environment variable, so
exporting them instead works too.

The repo pins pnpm via `packageManager`, but nothing here depends on it — npm or
yarn work the same if you'd rather (`npm install && npm start`).

## Install as a Claude Code plugin

The repo doubles as a single-plugin marketplace, so it installs from Claude Code:

```
/plugin marketplace add <this-repo-url>
/plugin install telegram-broker@claude-telegram-broker
```

During development, skip the marketplace and load it from disk:

```bash
claude --plugin-dir /path/to/claude-telegram-broker
```

It gives you three commands inside any Claude Code session:

| Command | What it does |
|---|---|
| `/telegram-broker:start` | Installs deps if needed, starts the daemon detached, and reports the startup checks (group reachable, privacy mode, Manage Topics) |
| `/telegram-broker:status` | Whether it's running, what the log says, which sessions exist — and, if Telegram itself looks wrong, asks the Telegram API instead of guessing |
| `/telegram-broker:stop` | SIGTERM, so live sessions close cleanly. Transcripts and the registry survive; the next start resumes each topic |

**The plugin does not *contain* the broker — it manages it.** A plugin is loaded
*inside* a Claude Code session, and the broker's whole job is to sit *above*
sessions and supervise them; running it inside one would put it back in the trap
this project exists to avoid (see [Why a broker](#why-a-broker)). So the daemon
stays a separate long-lived process, and the plugin is how you install, launch
and diagnose it.

## Configuration

| Variable | Default | What it does |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | — | **Required.** The token from @BotFather. |
| `TELEGRAM_ALLOWED_USERS` | — | **Required.** Comma-separated Telegram user IDs. Everyone else is dropped silently. The broker refuses to start if it's empty. |
| `TELEGRAM_GROUP_ID` | none | **Required for the topic-per-session workflow** — without it `/new` cannot open a topic. Only omit it if you want the degraded mode: talk to the bot in a DM and get a single session for the whole chat. |
| `BROKER_DEFAULT_CWD` | your home dir | The directory a session starts in when `/new` is given no path — so `/new` alone lands somewhere useful instead of `~`. Set it to wherever your repos live. It's also the cwd adopted when you message a conversation the broker has never seen. |
| `BROKER_STATE_FILE` | `~/.claude-telegram-broker.json` | Where the conversation → session-id registry is written. Move it if you want to run two brokers side by side. |
| `BROKER_MODEL` | the SDK's default | Model for spawned sessions, e.g. `claude-opus-4-8`. |
| `BROKER_PERMISSION_MODE` | `default` | Baseline behaviour for tools **not** in `BROKER_ASK_TOOLS`. See below. |
| `BROKER_ASK_TOOLS` | `Bash,Write,Edit,NotebookEdit` | Tools that **always** require an Allow/Deny confirmation in Telegram. |

### How the two permission settings interact

They are not alternatives — they cover different tools.

`BROKER_ASK_TOOLS` is the allowlist of tools that always stop and ask you, no
matter what. `BROKER_PERMISSION_MODE` decides what happens to *everything else*:

| Mode | Tools outside `BROKER_ASK_TOOLS` |
|---|---|
| `default` | Standard rules; anything unmatched runs without prompting you |
| `acceptEdits` | File edits are auto-accepted |
| `plan` | Claude explores and proposes, but doesn't edit |
| `bypassPermissions` | All checks skipped — but `BROKER_ASK_TOOLS` **still prompts** |

The practical consequence: `BROKER_ASK_TOOLS` is the real gate, and
`BROKER_PERMISSION_MODE` only tunes the background. Tightening the mode does not
compensate for emptying the ask list.

## Commands

| Command | What it does |
|---|---|
| `/new [--path <dir>] [name…]` | Start a session in a new topic. The path is a named parameter; everything else is the topic name, spaces and all. Without `--path` it starts in `BROKER_DEFAULT_CWD`; without a name the topic is named after the directory. |
| `/sessions` | Sessions this broker manages |
| `/all` | Every Claude session on this machine, brokered or not |
| `/history [n]` | Last `n` messages of this session's transcript |
| `/interrupt` | Stop what Claude is doing right now |
| `/stop` | End the session process — the transcript survives and the next message resumes it |

Anything that isn't a command is sent to Claude as a message.

## Security

**`TELEGRAM_ALLOWED_USERS` is mandatory** and gates on the *sender*, never the
chat: in a group, the chat id tells you nothing about who is typing. Anyone on
that list can approve tool calls — that is, run commands on your machine — so
only list people you trust with that authority.

**`BROKER_ASK_TOOLS` is load-bearing.** With `permissionMode: 'default'` alone
the SDK runs `Bash` **without ever calling `canUseTool`** — verified, not
assumed. Only an explicit `ask` rule forces the prompt. Emptying this list means
Claude edits files and runs shell commands unsupervised. The default
(`Bash,Write,Edit,NotebookEdit`) is the floor, not a suggestion.

## Verifying it works

```bash
pnpm smoke
```

Drives the `SessionManager` against a real Claude session with a fake frontend
and checks the four things everything else rests on: the session id is captured,
one live session remembers across turns, a stopped session resumes from disk, and
a `Bash` call is gated through the permission callback. Exits non-zero if any
fail.

## Extending it

`src/frontend.ts` is the seam. The broker and the session manager only ever talk
to the `Frontend` interface, so Discord, a web UI, or a CLI is a new
implementation of that one file — the session logic doesn't move.

| File | Role |
|---|---|
| `sessions.ts` | Owns the live Claude sessions (one `query()` each, kept alive by an `AsyncQueue` of user turns) |
| `telegram.ts` | The only owner of the bot token; topics, allowlist, permission buttons |
| `registry.ts` | The only state the broker keeps: conversation → session id + cwd |
| `frontend.ts` | The swappable-frontend interface |

Note what the registry *doesn't* store: transcripts and the session list. Claude
already keeps those on disk, and the SDK reads them (`listSessions`,
`getSessionMessages`), so there's no second copy to drift.

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
2. Create a Telegram **group with Topics enabled** and add the bot as admin
   (needs *Manage Topics*). Optional — without it you get one session per chat.
3. Configure and run:

```bash
cp .env.example .env    # fill in token, your user id, group id
npm install
npm start
```

Get your numeric user id from [@userinfobot](https://t.me/userinfobot).

## Commands

| Command | What it does |
|---|---|
| `/new [path]` | Start a session (opens a new topic if a forum group is set) |
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
npm run smoke
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

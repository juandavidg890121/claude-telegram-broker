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
4. Configure and run **from the cloned repo** — this is the development flow;
   to run it as an installed Claude Code plugin instead, see
   [Install as a Claude Code plugin](#install-as-a-claude-code-plugin), where the
   `.env` and `node_modules` live under `${CLAUDE_PLUGIN_ROOT}` rather than here:

```bash
cp .env.example .env    # fill in token, your user id, group id
pnpm install
pnpm start
```

Get your numeric user id from [@userinfobot](https://t.me/userinfobot).

5. **Only if you want `/watch`** (relaying into a session you have open in VS
   Code — `/new` and `/fork` need none of this): install two hooks, once, in
   `~/.claude/settings.json`.

   Print the block with real paths already filled in, from the checkout:

```bash
pnpm run print-hooks
```

   It emits exactly what to merge into `hooks` in `~/.claude/settings.json`:

```json
{
  "hooks": {
    "Stop": [{ "hooks": [{ "type": "command", "command":
      "/abs/path/to/repo/node_modules/.bin/tsx --env-file-if-exists=/abs/path/to/repo/.env /abs/path/to/repo/scripts/mirror/stop-hook.ts" }] }],
    "SessionStart": [{ "hooks": [{ "type": "command", "command":
      "/abs/path/to/repo/node_modules/.bin/tsx /abs/path/to/repo/scripts/mirror/session-start-hook.ts" }] }]
  }
}
```

   Generate it rather than hand-editing a template. A placeholder left unexpanded
   is not a visible error: the hook is a command that simply fails to start, so
   Claude Code carries on, no reply is ever mirrored, and nothing anywhere says
   why. Use `pnpm run print-hooks` and paste its output.

   They have to live inside the watched session, because the broker isn't driving
   it and never sees what happens there. `Stop` sends each reply **out** to
   Telegram and, between the two of them, they **arm the poller for you** — so
   `/watch` from your phone is the only thing you type. `SessionStart` catches
   sessions opened after you watched them; `Stop` catches sessions that were
   already open, at the end of their next turn.

   **Use an absolute path, and point it at the same tree the broker runs from.**
   Three traps here.

   `${CLAUDE_PLUGIN_ROOT}` is plugin-scoped — it is defined for hooks a plugin
   ships, not for `~/.claude/settings.json`, which is yours; don't count on it
   expanding there.

   An installed plugin is a *copy*: point a hook into `~/.claude/plugins/cache/…`
   and it silently goes stale the moment you change the source.

   And **reinstalling the plugin can rewrite these hook entries back to the cache
   copy**, undoing a path you fixed by hand. A hook pointing at a path that
   doesn't exist is not a visible error — the command simply fails to start,
   Claude Code carries on, and `/watch` goes half-dead with nothing anywhere
   saying why. If you're developing against a checkout, the least painful setup is
   to **not have the plugin installed at all** and run `pnpm start` from the
   checkout: two copies of the same code is a category of bug all by itself. If
   you keep both, re-run `pnpm run print-hooks` after every reinstall and check
   the paths still match.

   These are installed globally and run in **every** Claude session, so they are
   built to stay invisible: each looks itself up in the broker's state file and
   does nothing at all — no message, no poller — for a session no topic is
   watching. `/watch` reports whether they're installed, so you don't have to
   remember.

   Only `Stop` needs `--env-file-if-exists`: it is the one that talks to
   Telegram, and pointing it at the broker's `.env` is why the bot token never
   has to be pasted into `settings.json` — a file that tends to end up in dotfile
   repos.

### `.env` or exported variables — either works

Every setting is a plain environment variable read from `process.env`, and the
`.env` file is a convenience, not a requirement (`pnpm start` loads it *if
present* via `--env-file-if-exists`). So instead of a `.env` you can export the
variables in the shell you launch from:

```bash
export TELEGRAM_BOT_TOKEN='123456:ABC...'
export TELEGRAM_ALLOWED_USERS='123456789'
export TELEGRAM_GROUP_ID='-1001234567890'
pnpm start
```

This also works when the plugin's `/telegram-broker:start` launches the daemon:
it runs in the shell Claude Code inherited, so anything exported there (including
from your `~/.bashrc` / `~/.zshrc` or a systemd unit's `Environment=`) is picked
up — verified with the detached `nohup` launch the skill uses. Exported values
and a `.env` can coexist; the process environment wins for any key set in both,
since `--env-file` does not overwrite a variable already in the environment.

The repo pins pnpm via `packageManager`, but nothing here depends on it — npm or
yarn work the same if you'd rather (`npm install && npm start`).

## Install as a Claude Code plugin

The repo doubles as a single-plugin marketplace, so it installs from Claude Code:

```
/plugin marketplace add juandavidg890121/claude-telegram-broker
/plugin install telegram-broker@claude-telegram-broker
```

**Configuring a marketplace install.** Installing copies the plugin into Claude
Code's own directory, and `${CLAUDE_PLUGIN_ROOT}` — where `/telegram-broker:start`
looks for both `node_modules` and `.env` — points *there*, not at any repo you
cloned. For a single-plugin marketplace like this one that resolves to:

```
~/.claude/plugins/marketplaces/claude-telegram-broker
```

Since `.env` is gitignored it is **not** carried along by the install, so any
`.env` you filled in elsewhere is invisible to the installed copy. Give the
broker its configuration one of two ways:

- **Create `${CLAUDE_PLUGIN_ROOT}/.env`** — i.e.
  `~/.claude/plugins/marketplaces/claude-telegram-broker/.env` — by copying
  `.env.example` there and filling it in. Simplest, but a reinstall or update of
  the plugin overwrites the directory, so you lose it and recreate it.
- **Export the variables** (`TELEGRAM_BOT_TOKEN`, `TELEGRAM_ALLOWED_USERS`,
  `TELEGRAM_GROUP_ID`) from your `~/.bashrc` / `~/.zshrc`. The broker reads them
  straight from `process.env`, so they survive reinstalls and need no file inside
  the plugin directory. Preferred for a marketplace install.

Dependencies you do **not** configure: `/telegram-broker:start` runs
`pnpm install` (falling back to `npm install`) in `${CLAUDE_PLUGIN_ROOT}` on first
launch if `node_modules` is missing.

During development, skip the marketplace and load it from disk:

```bash
claude --plugin-dir /path/to/claude-telegram-broker
```

It gives you four commands inside any Claude Code session:

| Command | What it does |
|---|---|
| `/telegram-broker:start` | Installs deps if needed, starts the daemon detached, and reports the startup checks (group reachable, privacy mode, Manage Topics) |
| `/telegram-broker:status` | Whether it's running, what the log says, which sessions exist — and, if Telegram itself looks wrong, asks the Telegram API instead of guessing |
| `/telegram-broker:stop` | SIGTERM, so live sessions close cleanly. Transcripts and the registry survive; the next start resumes each topic |
| `/telegram-broker:watch <id>` | Arms *this* session to receive messages from a Telegram topic that ran `/watch <id>`. Only needed for `/watch`, and only in the session being watched |

**`start` does not set up `/watch`.** It launches the daemon, nothing more —
`/watch` additionally needs the one-time `Stop` hook from step 5 of
[Setup](#setup), plus `/telegram-broker:watch` in the session you want to reach.
`/new` and `/fork` work with neither.

**A marketplace install is a snapshot**, copied under `~/.claude/plugins/cache/`.
That is fine for the commands, which Claude loads from the copy — but point the
`Stop` hook and any local development at your own checkout instead, or you will
be debugging one tree while running another.

**The plugin does not *contain* the broker — it manages it.** A plugin is loaded
*inside* a Claude Code session, and the broker's whole job is to sit *above*
sessions and supervise them; running it inside one would put it back in the trap
this project exists to avoid (see [Why a broker](#why-a-broker)). So the daemon
stays a separate long-lived process, and the plugin is how you install, launch
and diagnose it.

## Configuration

Every setting below is an environment variable. The broker reads them from
`process.env`, so a `.env` file and shell-exported variables work the same and
can coexist (see [`.env` or exported variables](#env-or-exported-variables--either-works)).
Where the `.env` lives depends on how you run the broker:

- **From source** — `.env` at the repo root, next to `package.json`.
- **As an installed plugin** — `${CLAUDE_PLUGIN_ROOT}/.env`, i.e.
  `~/.claude/plugins/marketplaces/claude-telegram-broker/.env`. Because that
  directory is overwritten on reinstall, exporting the variables from your shell
  is the sturdier option — see
  [Configuring a marketplace install](#install-as-a-claude-code-plugin).

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
| `BROKER_MIRROR_DIR` | `~/.claude/telegram_mirror` | Where `/watch` leaves messages for a watched session, one subdirectory per session id. The broker and the poller armed inside the watched session both read it, so change it for both or neither. |
| `BROKER_WHISPER_DIR` | unset — **audio off** | Directory holding a local `whisper.cpp` and a model. Set it to transcribe voice notes; see [Voice notes](#voice-notes-optional). Unset, a voice note gets a short "audio is off" reply rather than silence. |
| `BROKER_WHISPER_MODEL` | first `ggml-*.bin` found | Model filename inside `BROKER_WHISPER_DIR`, when you keep several. Named but absent is an error, not a fallback to another model. |
| `BROKER_WHISPER_LANGUAGE` | `auto` | Spoken-language hint (`es`, `en`, …). `auto` detects per message; naming the language is slightly faster and more accurate if you always speak the same one. |

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
| `/fork <session-id> [name…]` | Branch any existing session into a new topic — full history loaded, new id, driven by the broker like any other. The original is never touched, so this is always safe, whether or not that session is open somewhere. Find ids with `/all`; the working directory comes from the session itself. See [Reaching a session you already have open](#reaching-a-session-you-already-have-open). |
| `/watch <session-id> [name…]` | Relay into a session **someone else is driving** (your VS Code one) instead of branching it: messages here are delivered into that session, and every reply it produces mirrors back to this topic. Needs arming from that session — see below. |
| `/sessions` | Sessions this broker manages. Watched topics are flagged, including whether they're armed right now |
| `/all [n] [--offset k] [--all]` | Every Claude session on this machine, brokered or not — grouped by project, newest first, each with its id, age and git branch. Defaults to the 30 most recent; `n` asks for a different count, `--offset k` pages through the rest, and `--all` dumps every one, split across as many messages as it takes. Each reply says which slice of the total it's showing, so a truncated list can't look like the whole set. Includes programmatic sessions (the broker's own included), which Claude Code's own session picker hides. |
| `/history [n]` | Last `n` messages of this session's transcript |
| `/mode [name]` | Show or change this session's permission mode. Persists, so it survives a restart and applies on resume. `BROKER_ASK_TOOLS` still prompts regardless — see below. (Switching *model* is Claude Code's own `/model`, below.) |
| `/interrupt` | Stop what Claude is doing right now |
| `/stop` | End the session process — the transcript survives and the next message resumes it |

Anything that isn't a command is sent to Claude as a message.

**Photos** are downloaded and handed to Claude as a file path for its `Read`
tool, along with any caption.

## Voice notes (optional)

**Claude cannot hear audio.** The Messages API takes text, images and PDFs; the
model advertises an `image_input` capability and no audio equivalent. A voice
note is therefore only useful once something turns it into text, and that
something is off by default.

**Why local, and not one of the speech APIs.** A hosted transcriber (Deepgram,
Groq, AssemblyAI…) is a couple of lines and a free tier away — and it would send
your microphone to a company you didn't choose, for every voice note, including
the ones where you're describing private code out loud. [PRIVACY.md](PRIVACY.md)
says this plugin runs entirely on your own machine and lists the third parties it
talks to as ones you already picked. Adding a fourth silently would make that
untrue. `whisper.cpp` keeps the promise and costs an install instead. (It's also
why not `faster-whisper` or `openai-whisper`: both are Python packages, and this
project has no Python — `python` doesn't even exist on stock Debian/Ubuntu.)

Nothing here is assumed present. With `BROKER_WHISPER_DIR` unset you get a short
"audio is off" reply; set but incomplete, you get a list of exactly what's
missing from that directory. Never silence.

### What to install

**1. `whisper.cpp`** — <https://github.com/ggml-org/whisper.cpp>

```bash
git clone --depth 1 https://github.com/ggml-org/whisper.cpp
cd whisper.cpp
cmake -B build -DCMAKE_BUILD_TYPE=Release -DBUILD_SHARED_LIBS=OFF
cmake --build build -j --config Release
cp build/bin/whisper-cli /path/to/your/whisper-dir/    # next to the model
```

**`-DBUILD_SHARED_LIBS=OFF` is load-bearing.** whisper.cpp defaults to shared
libraries, so the binary links against `libwhisper.so.1` and friends and is
useless on its own — copy it somewhere and it dies with `error while loading
shared libraries`, which reads like a broken binary rather than a missing sibling
file. Built static, `whisper-cli` is one self-contained file: copy it and delete
the checkout. (Older builds call it `main`; both are recognised.) A CPU build
needs nothing but `cmake` and a C++ compiler.

Add `-DGGML_CUDA=1` if you have the CUDA toolkit — read the warning below first.

⚠️ **`apt install nvidia-cuda-toolkit` may be too old for your GPU.** The CUDA
build needs a toolkit that knows your card's compute capability, and distro
packages lag: Ubuntu 24.04 ships CUDA 12.0, which cannot target Blackwell cards
(RTX 50xx, compute capability 12.0) — those need CUDA 12.8+ from NVIDIA's own
repo. `nvidia-smi` reporting "CUDA Version: 13.0" is the *driver's* ceiling, not
what you have installed; check `nvcc --version`. Mismatch it and the build fails
or produces a binary your GPU refuses. Start on CPU with `base` — it works with
no toolkit at all.

**2. A model** — `ggml-*.bin`, via the bundled script or straight from
Hugging Face: <https://huggingface.co/ggerganov/whisper.cpp/tree/main>

```bash
./models/download-ggml-model.sh base             # 148 MB — start here on CPU
./models/download-ggml-model.sh large-v3-turbo   # 1.62 GB — worth it on a GPU
```

**Pick by where it runs, not by quality.** On a CPU build the big models are not
slow, they're unusable — measured on a 24-thread Core Ultra 9, two seconds of
audio took **22.7 s** on `large-v3-turbo` and **1.2 s** on `base`. That's ~19×,
and it isn't model-loading time (both figures are warm). A voice note is short;
waiting a minute for it defeats the point.

| Model | Size | When |
|---|---|---|
| `base` | 148 MB | **CPU builds.** Fine for clear dictation, ~1 s for a short note. |
| `small` | 488 MB | CPU, if `base` mishears you too often. |
| `large-v3-turbo` | 1.62 GB | **CUDA builds.** `large-v3` with a distilled decoder — near-identical quality, several times faster. Pointless without a GPU. |
| `large-v3` | 3.1 GB | Only for Whisper's *translate* mode: turbo transcribes but does not translate. For speak-Spanish-get-Spanish, turbo. |

⚠️ **Don't grab a `.en` model.** Half the listing (`ggml-medium.en.bin`,
`ggml-small.en.bin`, …) is English-only, and they're byte-for-byte the same size
as the multilingual ones — easy to pick by mistake while scanning the sizes, and
the symptom is a transcript full of nonsense with no error. The multilingual
models are the ones *without* `.en`.

Quantized variants (`-q5_0`, `-q8_0`) trade accuracy for size and speed. They're
for machines short on memory — if yours isn't, take the full model.

**3. `ffmpeg`** — Telegram sends OGG/Opus and whisper.cpp wants 16 kHz mono WAV.
`apt install ffmpeg`, `brew install ffmpeg`, or <https://ffmpeg.org/download.html>.
It's found on `PATH`, so a system install is fine; a copy in the whisper
directory also works.

### Wire it up

Put the binary and the model in one directory and point at it:

```bash
BROKER_WHISPER_DIR=/opt/whisper        # contains whisper-cli + ggml-large-v3.bin
BROKER_WHISPER_LANGUAGE=es             # optional; 'auto' detects per message
```

Send a voice note and the transcript is echoed back to the topic (`🎙️ …`) before
it's acted on — transcription is a guess, and acting on a misheard instruction
without ever showing what was heard is how you find out afterwards. The audio
file is deleted as soon as it's transcribed; the text is the artefact.

## Reaching a session you already have open

You left a session running in VS Code and you're now on your phone. Two ways in,
and the difference is who is allowed to write to it.

**One session, one writer.** Two processes resuming the same session id write to
one transcript and corrupt it. Everything below exists to make that impossible by
construction rather than unlikely by detection.

### `/fork <id>` — take a branch and drive it

Copies the session's history into a **new id** the broker owns outright. You get
the full context on your phone; the original is untouched no matter what state
it's in. Nothing to detect, nothing to coordinate, no way to corrupt anything.

The cost is honest: it's a branch, not a mirror. What you say on the phone never
appears in VS Code, and the two diverge from that point.

### `/watch <id>` — relay into the live session

Keeps the original as the only writer and pushes your messages into it. Every
reply it produces — including turns you typed in VS Code yourself — mirrors back
to the topic, which is the point: you can see what Claude is doing in the session
you walked away from.

Once the [hooks](#setup) are installed, `/watch <id>` is all you type. The hooks
arm the session's poller themselves — a background task, live for that session's
lifetime, that touches a heartbeat once a second (how the broker knows the
session is listening — no pid, so nothing can go stale-but-reused) and claims the
messages the broker leaves for it.

**Self-arming is allowed to be best-effort**, and that is a deliberate line.
Nothing *forces* the session to arm: a hook can only hand the model an
instruction, and a model can ignore one. That is survivable here only because the
worst case is a refused message with a reason — the broker never falls back to
driving the session, so a missing poller can never become two writers. In the
original design, which did fall back, the same "probably arms" was a correctness
hole rather than an inconvenience.

The gap it leaves is narrow and worth knowing: a session sitting **idle** when
you watch it has nothing to trigger on. `SessionStart` fired long ago; `Stop`
fires at the end of a turn that isn't happening. It arms as soon as that session
does anything at all — or immediately, if you run `/telegram-broker:watch <id>`
in it, which is the same thing by hand.

### The poller dies with its session — the link doesn't

**Closing VS Code (or restarting the session) stops the watch.** The poller is a
`Monitor`, and a Monitor lives exactly as long as the session it was armed in.
Close the window and it's gone; the heartbeat goes stale within five seconds and
the topic starts answering `⏸️ Not delivered`.

**The link itself survives everything.** The topic→session mapping is a file, so
restarting the broker, restarting the session, or rebooting the machine all leave
it intact. **You never need to `/watch` again** — re-watching doesn't fix a
missing poller, because the mapping was never what broke.

To get it listening again, one of:

| | |
|---|---|
| **Type anything in that session** | The `Stop` hook fires at the end of the turn and re-arms it. Easiest if you're at the keyboard anyway. |
| **`/telegram-broker:watch <id>`** in that session | Arms it immediately, no turn needed. |
| **Reopen the session** | `SessionStart` fires on resume (`source: "resume"`) and re-arms it — provided you *resume* it. Open a **new** session instead and the id changes, so the watch still points at the old one and nothing arms. |

`/sessions` shows which topics are `👀 watching (armed)` versus `(not armed)`, so
you can check without guessing.

### One session, one topic

`/watch`-ing a session that another topic already watches **re-points it**: the
old topic is unlinked and told nothing, replies come to the new one. A second
topic on the same session would otherwise go permanently mute — its messages
would still arrive (the inbox is keyed by session, not by topic), but every reply
would land in the older topic.

Re-pointing is also the way back from a topic you deleted in Telegram. Its
registry entry is otherwise unreachable: unlinking is `/stop`, and `/stop` would
have to be typed in a topic that no longer exists.

### Undelivered messages expire after an hour

The inbox is files on disk, so it survives a reboot with messages still in it —
and an hour later, "deliver it now" is the wrong answer. Sending a question at
midnight, shutting the laptop, and having it answered into a conversation that
moved on the next morning is worse than not delivering it. Ask again.

### When the watched session isn't armed

Messages are **refused**, with a pointer to arming it or `/fork`-ing it. The
broker never quietly drives a watched session on your behalf.

That refusal is deliberate. Liveness here is a lease — a heartbeat that hasn't
been touched in five seconds — and a lease cannot tell "crashed" from "laptop
suspended" or "machine briefly overloaded". Any design that lets the broker take
over when it *thinks* the session is gone will eventually take over one that
isn't, and that is precisely the two-writer corruption. Refusing when we're
unsure is always safe; guessing is not.

### Claude Code's own commands work too

Any slash command the broker doesn't recognise is passed straight through to
Claude Code, so its commands work from Telegram unchanged — most usefully:

```
/model      list the available models, or switch: /model sonnet
/usage      5-hour and weekly quota, with the per-model breakdown
/context    what's filling the context window
/cost       what this session has cost
/compact    compact the conversation
```

The broker deliberately does **not** reimplement these. It briefly had its own
`/usage` and `/model`; both were strictly worse than the real ones *and* shadowed
them. Same principle as the registry: don't keep a second copy of something Claude
already owns.

One caveat worth knowing, because it surprised us: **`/model` does not survive
`/stop`.** Claude Code means "for this session only" literally — the running
process, not the saved transcript. On the next start the session goes back to
`BROKER_MODEL`. `/mode` *does* persist, because the broker owns it (there is no
native Claude Code command for permission mode) and writes it to the registry.

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
pnpm test        # fast, offline, free
```

The `/watch` handoff, tested where its bugs actually live: concurrency and the
liveness decision. Exactly-once delivery with two pollers racing, ordering when
messages land in the same millisecond, one session never seeing another's
messages, no partially-written file ever visible, and the heartbeat going stale
only when it should. Filesystem only — no API, no token, ~150ms. Uses the Node
test runner, so it adds no dependency.

```bash
pnpm smoke       # real API, ~2 min, costs tokens
pnpm smoke:fork
```

`smoke` drives the `SessionManager` against a real Claude session with a fake
frontend and checks the four things everything else rests on: the session id is
captured, one live session remembers across turns, a stopped session resumes from
disk, and a `Bash` call is gated through the permission callback.

`smoke:fork` checks the three promises `/fork` makes that no offline test can:
the working directory really does resolve from the session id alone, the fork
carries the original's context (it's asked to recall a codeword only the original
was told), and the original transcript doesn't grow. Both exit non-zero on
failure.

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

## Credits

Author: **Juan David Gomez**. MIT licensed — see [LICENSE.md](LICENSE.md).

Original idea and collaboration: **Daniel Leyva Ambrosio**.

Privacy: the plugin runs locally and collects nothing — see [PRIVACY.md](PRIVACY.md).

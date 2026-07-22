import { basename, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { readFileSync, statSync } from 'node:fs';
import {
  forkSession,
  getSessionInfo,
  getSessionMessages,
  listSessions,
  type SDKSessionInfo,
} from '@anthropic-ai/claude-agent-sdk';
import { CLAUDE_HOME } from './claude-home.js';
import { config } from './config.js';
import { Registry } from './registry.js';
import { PERMISSION_MODES, SessionManager } from './sessions.js';
import { TelegramFrontend } from './telegram.js';
import { heartbeatFresh, writeInboxMessage } from './mirror.js';
import { startAskWatcher } from './asks.js';
import { renderPreview } from './preview.js';
import { checkAlert } from './quota.js';
import { LoopComplaints, LoopStore, formatDuration, parseDuration, startLoopScheduler, type Loop } from './loops.js';
import {
  HeartbeatStore,
  HEARTBEAT_ESCALATED_PROMPT,
  HEARTBEAT_PING_PROMPT,
  PongStore,
  parseHeartbeatInterval,
  startHeartbeatScheduler,
  type Heartbeat,
} from './heartbeat.js';
import type { Frontend, Inbound } from './frontend.js';

const registry = new Registry(config.stateFile);
const loops = new LoopStore(config.loopsFile);
const heartbeats = new HeartbeatStore(config.heartbeatsFile);
const pongs = new PongStore(config.pongFile);
const frontend: Frontend = new TelegramFrontend();

const sessions = new SessionManager({
  registry,
  emit: (conversationId, text) => frontend.sendText(conversationId, text),
  confirm: (conversationId, ask) => frontend.askPermission(conversationId, ask),
  ask: (conversationId, ask) => frontend.askQuestions(conversationId, ask),
  // The broker-owned half of what the Stop hook already does for watched
  // sessions. Without it the 90% warning only ever reaches sessions running in
  // someone's VS Code — the ones driven from the phone would burn through the
  // window and find out by being ignored.
  turnEnded: async (conversationId) => {
    const alert = await checkAlert();
    if (alert) await frontend.sendText(conversationId, alert);
  },
});

/**
 * AskUserQuestion in a *watched* session. The broker-owned path needs none of
 * this — there the question arrives on canUseTool, in this process.
 *
 * The hook that raised it is blocked on the answer file right now, holding that
 * session's turn open, so anything slow or throwing here costs someone real
 * time. askQuestions already resolves undefined rather than throwing when the
 * deadline passes, which is what keeps that promise bounded.
 */
const askWatcher = startAskWatcher(
  () => registry.list().flatMap((entry) => (entry.watch && entry.sessionId ? [entry.sessionId] : [])),
  async (request) => {
    const entry = registry.list().find((e) => e.sessionId === request.sessionId && e.watch);
    if (!entry) return undefined; // Unwatched between the hook writing and now.

    return frontend.askQuestions(entry.conversationId, {
      id: request.id,
      questions: request.questions,
      // Which session, because a watched topic's questions come from a window
      // you are not looking at — unlike an owned session, where the only thing
      // that could be asking is the conversation you are already reading.
      note: `❓ ${entry.title} (${request.sessionId.slice(0, 8)}) is asking:`,
      // The hook's deadline, not one of our own. It is the side that actually
      // gives up, and buttons that outlive it are buttons that do nothing.
      expiresAt: request.expiresAt,
    });
  },
);

frontend.onCommand('help', async (msg) => {
  await frontend.sendText(
    msg.conversationId,
    [
      '/new [--path <dir>] [name…] — start a session in a new topic.',
      '    /new fix the login bug        → default directory, topic "fix the login bug"',
      '    /new --path ~/code/repo       → topic "repo"',
      '    /new --path ~/code/repo tests → topic "tests"',
      '/fork <session-id> [name…] — branch an existing session into a new topic.',
      '    Full history, new id, yours to drive. The original is never touched.',
      '/watch <session-id> [name…] — relay into a session someone else is driving',
      '    (your VS Code one). Every reply mirrors back here. Arm it from that',
      '    session with /telegram-broker:watch <id>.',
      '/sessions — sessions this broker manages',
      '/all [n] [--offset k] [--all] — every Claude session on this machine, brokered or not',
      `    /all              → the ${ALL_PAGE} most recent, grouped by project`,
      '    /all 50           → the 50 most recent',
      `    /all --offset ${ALL_PAGE}    → the next page`,
      '    /all --all        → all of them, across several messages',
      '/history [n] — last n messages of this session',
      '/loop <interval> <prompt…> — fire prompt into this conversation on a',
      '    repeat, e.g. /loop 2h check the deploy queue. Interval: 30m, 2h, 1d…',
      '/loops — list this conversation’s scheduled loops',
      '/unloop <id> — cancel a loop',
      '/reloop <id> <interval> <prompt…> — replace a loop’s interval and prompt',
      '/heartbeat <interval> — periodically verify Telegram mirroring is alive,',
      '    e.g. /heartbeat 30m. Minimum 5m. Escalates to an urgent in-session',
      '    prompt if a ping goes unanswered.',
      '/heartbeats — show this conversation’s heartbeat, if any',
      '/unheartbeat — turn it off',
      '/mode [name] — show or change this session’s permission mode',
      '/stop — end this session (the transcript survives; the next message resumes it)',
      '/interrupt — stop what Claude is doing right now',
      '',
      'Any other slash command goes straight to Claude Code, so its own commands',
      'work here: /model (lists and switches models), /usage (5-hour and weekly',
      'quota), /context, /cost, /compact.',
      'Anything that is not a command is sent to Claude as a message.',
    ].join('\n'),
  );
});

frontend.onCommand('new', async (msg, args) => {
  const { cwd, title } = parseNew(args);

  // Claude starting in a directory that doesn't exist is a confusing way to
  // fail, several turns later. Fail here instead.
  if (!statSync(cwd, { throwIfNoEntry: false })?.isDirectory()) {
    throw new Error(`Not a directory: ${cwd}`);
  }

  const conversationId = await frontend.createConversation(title, msg);
  sessions.register(conversationId, cwd, title);

  // A frontend with nowhere to put a new thread hands back the conversation we
  // were called from. Say so — silently reusing the current topic looks like
  // success and is how you end up with two sessions fighting over one thread.
  const reused = conversationId === msg.conversationId;
  const note = reused
    ? '\n⚠️ No new topic was created (TELEGRAM_GROUP_ID is unset), so this session lives in the current thread.'
    : '';

  await frontend.sendText(
    conversationId,
    `🟢 Session \`${title}\` ready in \`${cwd}\`. Send a message to start.${note}`,
  );
});

/**
 * `/new [--path <dir>] [name…]`
 *
 * The path is a named parameter and everything else is the session name. An
 * earlier version guessed — a leading `/`, `~` or `.` meant "path", anything
 * else meant "name" — which reads `/new fix the login bug` as a directory. No
 * guessing here: only `--path` is a path, and a name may contain spaces.
 */
function parseNew(args: string): { cwd: string; title: string } {
  const tokens = args.trim().split(/\s+/).filter(Boolean);

  let path: string | undefined;
  const nameParts: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i] === '--path' || tokens[i] === '-p') {
      path = tokens[++i];
      if (!path) throw new Error('--path needs a directory, e.g. /new --path ~/code/repo');
      continue;
    }
    nameParts.push(tokens[i]);
  }

  const cwd = resolve((path ?? config.defaultCwd).replace(/^~(?=$|\/)/, homedir()));
  return { cwd, title: nameParts.join(' ') || basename(cwd) };
}

/**
 * Resolve a session id the user typed, and find out where it ran.
 *
 * `getSessionInfo` searches every project directory when given no `dir`, so the
 * cwd never has to be supplied by hand — the session already knows it. Note that
 * it also returns undefined for a session with no extractable summary, so a miss
 * is not proof of "no such id"; the error says so rather than asserting.
 */
async function resolveSession(sessionId: string, pathOverride?: string): Promise<SDKSessionInfo & { cwd: string }> {
  if (!/^[0-9a-f-]{8,}$/i.test(sessionId)) {
    throw new Error(`"${sessionId}" is not a session id. Find ids with /all.`);
  }

  const info = await getSessionInfo(sessionId);
  if (!info) {
    throw new Error(
      `No session \`${sessionId}\` found on this machine.\n` +
        `Check the id with /all. (A session with no summary can also read as missing here.)`,
    );
  }

  const cwd = pathOverride ?? info.cwd;
  if (!cwd) {
    throw new Error(
      `Session \`${sessionId}\` has no recorded working directory, so it can't be started.\n` +
        `Pass one explicitly: --path <dir>`,
    );
  }
  return { ...info, cwd };
}

/** `<id> [--path <dir>] [name…]` — same shape as /new's parser, id first. */
function parseSessionArgs(args: string): { sessionId: string; cwd?: string; title?: string } {
  const tokens = args.trim().split(/\s+/).filter(Boolean);
  const sessionId = tokens.shift() ?? '';

  let cwd: string | undefined;
  const nameParts: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i] === '--path' || tokens[i] === '-p') {
      const path = tokens[++i];
      if (!path) throw new Error('--path needs a directory.');
      cwd = resolve(path.replace(/^~(?=$|\/)/, homedir()));
      continue;
    }
    nameParts.push(tokens[i]);
  }
  return { sessionId, cwd, title: nameParts.join(' ') || undefined };
}

/**
 * Is the Stop hook wired up? Checked rather than assumed, because its absence is
 * invisible from the phone: /watch reports success, the session runs fine, and
 * replies simply never arrive with nothing anywhere saying why.
 *
 * A substring match on the script name is enough — this only ever drives a
 * hint, so a false positive costs a misleading tick, not a broken session.
 */
function hookInstalled(): boolean {
  return [
    join(CLAUDE_HOME, 'settings.json'),
    join(CLAUDE_HOME, 'settings.local.json'),
  ].some((file) => {
    try {
      return readFileSync(file, 'utf8').includes('stop-hook');
    } catch {
      return false;
    }
  });
}

async function preview(sessionId: string): Promise<string> {
  try {
    return renderPreview(await getSessionMessages(sessionId));
  } catch (error) {
    // Never fail /watch or /fork over a cosmetic preview — but say so, because a
    // silently missing preview is indistinguishable from an empty session.
    console.warn(`[preview] ${sessionId}: ${error instanceof Error ? error.message : String(error)}`);
    return '';
  }
}

frontend.onCommand('fork', async (msg, args) => {
  const { sessionId, cwd: override, title } = parseSessionArgs(args);
  if (!sessionId) throw new Error('/fork <session-id> [--path <dir>] [name…] — find ids with /all.');

  const info = await resolveSession(sessionId, override);
  const topicTitle = title || info.summary || sessionId.slice(0, 8);

  // Fork up front rather than passing `forkSession` through to query(): the new
  // id exists immediately, so the entry is a perfectly ordinary owned session
  // from here on. Deferring it would mean carrying a "still needs forking" flag
  // that has to be cleared the first time init reports the new id — and forking
  // the fork on every restart if it ever isn't.
  const forked = await forkSession(sessionId, { title: topicTitle });

  const conversationId = await frontend.createConversation(topicTitle, msg);
  const entry = sessions.register(conversationId, info.cwd, topicTitle);
  entry.sessionId = forked.sessionId;
  registry.put(entry);

  const reused = conversationId === msg.conversationId;
  await frontend.sendText(
    conversationId,
    `🍴 Forked \`${sessionId.slice(0, 8)}\` → \`${forked.sessionId.slice(0, 8)}\` in \`${info.cwd}\`.\n` +
      `Full history is loaded; this branch is yours to drive. The original is untouched — ` +
      `nothing you say here reaches it.` +
      (reused ? '\n⚠️ TELEGRAM_GROUP_ID is unset, so this lives in the current thread.' : '') +
      (await preview(sessionId)),
  );
});

frontend.onCommand('watch', async (msg, args) => {
  const { sessionId, cwd: override, title } = parseSessionArgs(args);
  if (!sessionId) throw new Error('/watch <session-id> [name…] — find ids with /all.');

  const info = await resolveSession(sessionId, override);
  const topicTitle = title || info.summary || sessionId.slice(0, 8);

  // One session, one topic. The lookup that finds a session's topic takes the
  // first match, so a second topic on the same session would go permanently
  // mute: its messages still arrive (the inbox is keyed by session), but every
  // reply lands in the older topic. Re-pointing rather than refusing is also the
  // only way back from a topic that was deleted in Telegram — its entry is
  // otherwise unreachable, since /stop would have to be typed in a topic that no
  // longer exists.
  const previous = registry.list().find((e) => e.sessionId === sessionId && e.watch);
  if (previous) registry.remove(previous.conversationId);

  const conversationId = await frontend.createConversation(topicTitle, msg);
  const entry = sessions.register(conversationId, info.cwd, topicTitle);
  entry.sessionId = sessionId;
  entry.watch = true;
  registry.put(entry);

  const moved =
    previous && previous.conversationId !== conversationId
      ? `\n\n♻️ Was already watched by another topic — that one is now unlinked, replies come here.`
      : '';

  const reused = conversationId === msg.conversationId;
  // The hooks arm the poller themselves, so the only thing that can still be
  // missing is the hooks. Report that, rather than a checklist the user no
  // longer has to work through.
  const armed = heartbeatFresh(sessionId);
  const status = hookInstalled()
    ? armed
      ? `✅ Armed and listening — talk away.`
      : `⏳ Not armed yet. It arms itself the moment that session finishes its next turn ` +
        `(type anything there), or right away if you reopen it. To arm it now without waiting, ` +
        `run this in that session:\n       /telegram-broker:watch ${sessionId}`
    : `❌ The hooks aren't installed, so nothing will flow — no replies out, and no self-arming. ` +
      `They're a one-time setup in ~/.claude/settings.json; see the README.`;

  await frontend.sendText(
    conversationId,
    `👀 Watching \`${sessionId.slice(0, 8)}\` in \`${info.cwd}\`.\n\n` +
      `${status}\n\n` +
      `Every reply that session produces comes back here, including turns typed in VS Code — ` +
      `one process, no second writer. To branch it and drive it from here instead: ` +
      `/fork ${sessionId}` +
      moved +
      (reused ? '\n⚠️ TELEGRAM_GROUP_ID is unset, so this lives in the current thread.' : '') +
      (await preview(sessionId)),
  );
});

/**
 * `/telegram-broker:watch` belongs in the watched session, not here — but it is
 * printed *here*, so typing it here is the obvious mistake. Without this it
 * falls through to onMessage and gets relayed (or refused) as if it were a
 * message for Claude, which explains nothing.
 */
frontend.onCommand('telegram-broker:watch', async (msg, args) => {
  const id = args.trim().split(/\s+/)[0] || '<session-id>';
  await frontend.sendText(
    msg.conversationId,
    `That one goes in the session you're watching, not here — it's a Claude Code ` +
      `command, and this is Telegram. Run it in that VS Code window:\n\n` +
      `    /telegram-broker:watch ${id}\n\n` +
      `You usually don't need to: with the hooks installed it arms itself when that ` +
      `session next finishes a turn.`,
  );
});

frontend.onCommand('sessions', async (msg) => {
  const entries = registry.list();
  const body = entries.length
    ? entries
        .map((e) => {
          const kind = e.watch
            ? heartbeatFresh(e.sessionId ?? '')
              ? ' 👀 watching (armed)'
              : ' 👀 watching (not armed)'
            : '';
          return `• ${e.title}${kind} — ${e.cwd}\n  ${e.sessionId ?? '(not started yet)'}`;
        })
        .join('\n')
    : 'No sessions yet. Use /new, /fork or /watch.';
  await frontend.sendText(msg.conversationId, body);
});

const ALL_PAGE = 30;

frontend.onCommand('all', async (msg, args) => {
  const { limit, offset } = parseAll(args);

  // Claude already keeps its own session index on disk — read it rather than
  // maintaining a second, drift-prone copy. Listing unpaginated and slicing
  // here costs one directory scan and is what makes an honest "of N" possible;
  // asking the SDK for a page can only ever report the page.
  const all = await listSessions();
  if (!all.length) {
    await frontend.sendText(msg.conversationId, 'No sessions found on this machine.');
    return;
  }

  const page = all.slice(offset, offset + limit);
  if (!page.length) {
    await frontend.sendText(
      msg.conversationId,
      `Offset ${offset} is past the end — there are ${all.length} sessions.`,
    );
    return;
  }

  const shown = `Sessions ${offset + 1}–${offset + page.length} of ${all.length}`;
  const next = offset + page.length;
  const footer =
    next < all.length
      ? `\n\n${all.length - next} more. Next: /all --offset ${next}  ·  everything: /all --all`
      : '';

  await frontend.sendText(msg.conversationId, `${shown}\n\n${groupByProject(page)}${footer}`);
});

/**
 * `/all [n] [--offset k] [--all]`
 *
 * Long output is not a reason to truncate here: sendText already splits at
 * Telegram's message cap, so `--all` genuinely means all.
 */
function parseAll(args: string): { limit: number; offset: number } {
  const tokens = args.trim().split(/\s+/).filter(Boolean);

  let limit: number | undefined;
  let offset = 0;
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token === '--all' || token === '-a') {
      limit = Number.POSITIVE_INFINITY;
      continue;
    }
    if (token === '--offset' || token === '-o') {
      offset = Number(tokens[++i]);
      if (!Number.isInteger(offset) || offset < 0) {
        throw new Error('--offset needs a whole number, e.g. /all --offset 30');
      }
      continue;
    }
    const n = Number(token);
    if (!Number.isInteger(n) || n <= 0) {
      throw new Error(`Unexpected "${token}". Usage: /all [n] [--offset k] [--all]`);
    }
    limit = n;
  }

  return { limit: limit ?? ALL_PAGE, offset };
}

/**
 * Sessions come back newest-first across every project at once, which reads as
 * noise. Group them by directory, keeping projects ordered by their most recent
 * session so the top of the message is still what you touched last.
 */
function groupByProject(sessions: SDKSessionInfo[]): string {
  const byProject = new Map<string, SDKSessionInfo[]>();
  for (const session of sessions) {
    const key = session.cwd ?? '(unknown directory)';
    const bucket = byProject.get(key);
    if (bucket) bucket.push(session);
    else byProject.set(key, [session]);
  }

  return [...byProject]
    .map(([cwd, group]) => {
      const lines = group.map((s) => {
        // Outside a checked-out branch the SDK reports a literal "HEAD", which
        // is noise on the majority of rows rather than information.
        const branch = s.gitBranch && s.gitBranch !== 'HEAD' ? ` · ${s.gitBranch}` : '';
        return `• ${s.summary || '(no summary)'}\n  ${s.sessionId}\n  ${ago(s.lastModified)}${branch}`;
      });
      return `📁 ${cwd} (${group.length})\n${lines.join('\n')}`;
    })
    .join('\n\n');
}

function ago(timestamp: number): string {
  const minutes = Math.round((Date.now() - timestamp) / 60_000);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

frontend.onCommand('history', async (msg, args) => {
  const entry = registry.get(msg.conversationId);
  if (!entry?.sessionId) {
    await frontend.sendText(msg.conversationId, 'This conversation has no session yet.');
    return;
  }
  const count = Number(args.trim()) || 10;
  const messages = await getSessionMessages(entry.sessionId);
  const body = messages
    .slice(-count)
    .map((m) => `— ${JSON.stringify(m).slice(0, 300)}`)
    .join('\n');
  await frontend.sendText(msg.conversationId, body || 'Transcript is empty.');
});

frontend.onCommand('mode', async (msg, args) => {
  const entry = registry.get(msg.conversationId);
  const wanted = args.trim();

  // A watched session runs under its own UI's permission settings. Silently
  // storing a mode here would be a lie that comes true later, the moment the
  // entry is ever driven for real.
  if (entry?.watch) {
    if (!wanted) {
      await frontend.sendText(
        msg.conversationId,
        `This topic watches a live session. Its permission mode belongs to that ` +
          `session's own UI, not to the broker.`,
      );
      return;
    }
    throw new Error(
      `Can't set permission mode here: this topic watches a session, it doesn't drive it. ` +
        `Change it in that session's own UI, or /fork to get one this broker owns.`,
    );
  }

  if (!wanted) {
    const current = entry?.permissionMode ?? `${config.permissionMode} (broker default)`;
    await frontend.sendText(
      msg.conversationId,
      `Permission mode: *${current}*\n\n` +
        PERMISSION_MODES.map((m) => `• ${m}`).join('\n') +
        `\n\nThis is the baseline for tools outside BROKER_ASK_TOOLS ` +
        `(${config.askTools.join(', ')}), which always ask — even in bypassPermissions.`,
    );
    return;
  }

  const mode = PERMISSION_MODES.find((m) => m.toLowerCase() === wanted.toLowerCase());
  if (!mode) throw new Error(`Unknown mode "${wanted}". One of: ${PERMISSION_MODES.join(', ')}`);

  await sessions.setPermissionMode(msg.conversationId, mode);
  await frontend.sendText(msg.conversationId, `🔐 Permission mode: *${mode}*`);
});

frontend.onCommand('interrupt', async (msg) => {
  if (registry.get(msg.conversationId)?.watch) {
    throw new Error(
      `Can't interrupt from here: this topic watches a session, it doesn't drive it. ` +
        `Use Esc in that session's own UI.`,
    );
  }
  await sessions.interrupt(msg.conversationId);
  await frontend.sendText(msg.conversationId, '⏹️ Interrupted.');
});

frontend.onCommand('stop', async (msg) => {
  if (registry.get(msg.conversationId)?.watch) {
    // Unlink only. The watched session belongs to whoever is driving it; the
    // broker has no business ending it.
    registry.remove(msg.conversationId);
    await frontend.sendText(
      msg.conversationId,
      `🔴 Stopped watching. That session is untouched — this only unlinks this topic. ` +
        `/watch it again to relink.`,
    );
    return;
  }
  await sessions.stop(msg.conversationId);
  await frontend.sendText(msg.conversationId, '🔴 Session stopped. Send a message to resume it.');
});

/** Whether a prompt reached the session, and if not, why — the caller decides
 *  what that is worth saying, because the answer differs for a person who just
 *  typed and a timer that fired.
 *
 *  Deliberately does not check quota first. A message pushed into a session
 *  with no quota left is answered by nothing at all — the turn dies wherever
 *  it dies and the topic stays quiet — but that is the account's own limit
 *  playing out, not this broker's decision to make on the user's behalf.
 *  Refusing to even try was a worse failure than the silence it was meant to
 *  explain: it stopped every message, not just the ones that would truly have
 *  failed, on nothing firmer than a rounded percentage or a status string this
 *  broker does not fully control the meaning of. checkAlert (see quota.ts)
 *  still surfaces a warning near the limit — this just no longer acts on it. */
type Delivery = { status: 'delivered' | 'not-listening' };

/**
 * Deliver text into a conversation exactly as if the user had typed it —
 * watched-session inbox routing or driving a broker-owned session directly. The
 * single path both a real inbound Telegram message and a due /loop prompt go
 * through, so a loop is indistinguishable from having typed it yourself.
 */
async function deliverMessage(conversationId: string, text: string): Promise<Delivery> {
  const entry =
    registry.get(conversationId) ?? sessions.register(conversationId, config.defaultCwd, 'default');

  if (entry.watch && entry.sessionId) {
    // Deliberately no headless fallback. Driving the session here because it
    // *looks* gone is how you get two writers on one transcript: liveness is a
    // lease, a lease has false positives, and a suspended laptop is
    // indistinguishable from a closed one. Refusing is always safe; guessing
    // is not. /fork is the answer when the session really is gone.
    if (!heartbeatFresh(entry.sessionId)) return { status: 'not-listening' };
    writeInboxMessage(entry.sessionId, text);
    return { status: 'delivered' };
  }

  await sessions.send(conversationId, text);
  return { status: 'delivered' };
}

frontend.onMessage(async (msg: Inbound) => {
  const outcome = await deliverMessage(msg.conversationId, msg.text);
  if (outcome.status === 'delivered') return;

  const entry = registry.get(msg.conversationId);
  // Name all three ways back. The commonest cause is a closed VS Code window —
  // the poller is a Monitor and dies with its session — and the instinct then is
  // to /watch again, which fixes nothing: the mapping is on disk and was never
  // what broke.
  await frontend.sendText(
    msg.conversationId,
    `⏸️ Not delivered — nothing is listening in ${entry?.sessionId?.slice(0, 8)} right now. ` +
      `Its watcher stops when that session closes; you don't need to /watch again, ` +
      `the link is still here. To get it listening:\n\n` +
      `• type anything in that session — it re-arms when the turn ends\n` +
      `• or run there: /telegram-broker:watch ${entry?.sessionId}\n` +
      `• or reopen it — resuming re-arms it automatically\n\n` +
      `If it's gone for good, /fork ${entry?.sessionId} branches it and I'll drive it from here.`,
  );
});

/**
 * In memory on purpose: a restart is exactly when a still-broken loop is worth
 * hearing about again, and persisting it would mean another file to keep atomic
 * for what is only a hint.
 */
const complaints = new LoopComplaints();

/**
 * A due loop, delivered with the two judgements a timer needs and a person does
 * not.
 *
 * Skip while working: someone typing a second message mid-turn means it, and it
 * queues. A timer firing again because the last answer is still being written
 * means nothing — and queueing it builds a backlog that never drains, since the
 * next fire is already scheduled. A 1m loop against 5m turns queues five
 * prompts every five minutes, forever. The minimum interval does not save you
 * from this; only skipping does.
 *
 * Complain once: a loop pointed at a closed VS Code session cannot deliver, and
 * saying so every 30 minutes for a week is how you learn to ignore the topic.
 * Say it on the first miss, then go quiet until it lands again — the same shape
 * as the quota alert, and for the same reason.
 */
async function deliverLoop(loop: Loop): Promise<void> {
  if (sessions.isWorking(loop.conversationId)) {
    console.log(`[loops] ${loop.id} skipped: still working on the last one`);
    return;
  }

  const outcome = await deliverMessage(loop.conversationId, loop.prompt);
  if (!complaints.shouldReport(loop.id, outcome.status)) return;

  await frontend.sendText(
    loop.conversationId,
    `🔁 Loop ${loop.id} couldn't fire — nothing is listening in this watched session. ` +
      `It keeps trying every ${formatDuration(loop.intervalMs)} and will say nothing more until it lands; ` +
      `/unloop ${loop.id} to stop it.`,
  );
}

/**
 * A due heartbeat, delivered with the same skip-while-working judgement
 * deliverLoop makes, plus the freshness check this feature exists for.
 *
 * Freshness: has a pong landed since the LAST ping this heartbeat sent? If
 * hb.lastPingAt is null (first ping ever) there is nothing to check yet —
 * ping normally. Otherwise compare pongs.lastPongAt(sessionId) against
 * hb.lastPingAt: a pong strictly after the last ping means that ping's turn
 * produced a real successful mirror, so the channel is alive. A missing or
 * stale pong means the last ping went unanswered — escalate.
 */
async function deliverHeartbeat(hb: Heartbeat): Promise<void> {
  if (sessions.isWorking(hb.conversationId)) {
    console.log(`[heartbeat] ${hb.conversationId} skipped: still working on the last one`);
    return;
  }

  const entry = registry.get(hb.conversationId);
  const sessionId = entry?.sessionId;

  let escalate = false;
  if (hb.lastPingAt !== null && sessionId) {
    const lastPong = pongs.lastPongAt(sessionId);
    escalate = lastPong === null || lastPong <= hb.lastPingAt;
  }

  const prompt = escalate ? HEARTBEAT_ESCALATED_PROMPT : HEARTBEAT_PING_PROMPT;
  const outcome = await deliverMessage(hb.conversationId, prompt);
  heartbeats.markPinged(hb.conversationId, escalate);

  // Delivery-failure reporting mirrors deliverLoop exactly (report once via
  // the shared LoopComplaints instance, keyed by conversationId since there
  // is only one heartbeat per conversation — no id to disambiguate several,
  // unlike a loop). The escalated PROMPT ITSELF (sent to Claude, inside the
  // session) is unrelated to this — this block is only about telling the
  // Telegram user the ping couldn't even be delivered at all (nothing is
  // listening in the session), which needs the same "say it once" treatment
  // a loop's delivery failure gets. Delivery's status is only ever
  // 'delivered' | 'not-listening' (see the type above) — quota no longer
  // blocks delivery at all.
  if (outcome.status === 'delivered') return;
  if (!complaints.shouldReport(`heartbeat:${hb.conversationId}`, outcome.status)) return;

  await frontend.sendText(
    hb.conversationId,
    `💓 Heartbeat couldn't ping — nothing is listening in this watched session. ` +
      `It keeps trying every ${formatDuration(hb.intervalMs)} and will say nothing more until it lands; ` +
      `/unheartbeat to stop it.`,
  );
}

const heartbeatScheduler = startHeartbeatScheduler(heartbeats, deliverHeartbeat);

const loopScheduler = startLoopScheduler(loops, deliverLoop);

/**
 * `/loop <interval> <prompt…>` — schedule prompt to fire into this
 * conversation every interval, starting one interval from now.
 */
frontend.onCommand('loop', async (msg, args) => {
  const tokens = args.trim().split(/\s+/);
  const intervalText = tokens.shift() ?? '';
  const prompt = tokens.join(' ');
  if (!intervalText || !prompt) {
    throw new Error(
      '/loop <interval> <prompt…> — e.g. /loop 2h check the deploy queue.\n' +
        'Manage existing loops: /loops, /unloop <id>, /reloop <id> <interval> <prompt…>',
    );
  }
  const intervalMs = parseDuration(intervalText);
  const loop = loops.add(msg.conversationId, intervalMs, prompt);
  await frontend.sendText(
    msg.conversationId,
    `🔁 Loop ${loop.id} set — "${prompt}" every ${formatDuration(intervalMs)}, ` +
      `first fire in ${formatDuration(intervalMs)}.\n/unloop ${loop.id} to cancel.`,
  );
});

frontend.onCommand('loops', async (msg) => {
  const mine = loops.listFor(msg.conversationId);
  if (!mine.length) {
    await frontend.sendText(msg.conversationId, 'No loops in this conversation. /loop <interval> <prompt…> to add one.');
    return;
  }
  const body = mine
    .map((l) => {
      const inMs = l.nextFireAt - Date.now();
      // No clamping to a minute: a loop due in 20s should say 20s, not round
      // itself up into a lie about when it will actually fire.
      const nextIn = inMs > 0 ? `next in ${formatDuration(inMs)}` : 'due now';
      return `• ${l.id} — every ${formatDuration(l.intervalMs)} (${nextIn})\n  "${l.prompt}"`;
    })
    .join('\n');
  await frontend.sendText(msg.conversationId, body);
});

frontend.onCommand('unloop', async (msg, args) => {
  const id = args.trim().split(/\s+/)[0];
  if (!id) throw new Error('/unloop <id> — find ids with /loops.');
  if (!loops.remove(msg.conversationId, id)) {
    throw new Error(`No loop ${id} in this conversation. Check the id with /loops.`);
  }
  // Ids are random, but they are only 3 bytes: a new loop could be handed this
  // one back, and would inherit its silence.
  complaints.forget(id);
  await frontend.sendText(msg.conversationId, `🛑 Loop ${id} cancelled.`);
});

frontend.onCommand('reloop', async (msg, args) => {
  const tokens = args.trim().split(/\s+/);
  const id = tokens.shift() ?? '';
  const intervalText = tokens.shift() ?? '';
  const prompt = tokens.join(' ');
  if (!id || !intervalText || !prompt) {
    throw new Error('/reloop <id> <interval> <prompt…> — find ids with /loops.');
  }
  const intervalMs = parseDuration(intervalText);
  const loop = loops.edit(msg.conversationId, id, intervalMs, prompt);
  if (!loop) throw new Error(`No loop ${id} in this conversation. Check the id with /loops.`);
  await frontend.sendText(
    msg.conversationId,
    `🔁 Loop ${loop.id} updated — "${prompt}" every ${formatDuration(intervalMs)}, next fire in ${formatDuration(intervalMs)}.`,
  );
});

/**
 * `/heartbeat <interval>` — periodically verify this conversation's Stop-hook
 * mirror is alive; escalates to an urgent in-session prompt on a miss.
 */
frontend.onCommand('heartbeat', async (msg, args) => {
  const intervalText = args.trim().split(/\s+/)[0] ?? '';
  if (!intervalText) {
    throw new Error('/heartbeat <interval> — e.g. /heartbeat 30m. Minimum 5m.\nManage it: /heartbeats, /unheartbeat');
  }
  const intervalMs = parseHeartbeatInterval(intervalText);
  heartbeats.enable(msg.conversationId, intervalMs);
  await frontend.sendText(
    msg.conversationId,
    `💓 Heartbeat set — checking every ${formatDuration(intervalMs)}, first check in ${formatDuration(intervalMs)}.\n/unheartbeat to cancel.`,
  );
});

frontend.onCommand('heartbeats', async (msg) => {
  const hb = heartbeats.get(msg.conversationId);
  if (!hb) {
    await frontend.sendText(msg.conversationId, 'No heartbeat in this conversation. /heartbeat <interval> to add one.');
    return;
  }
  const inMs = hb.nextPingAt - Date.now();
  const nextIn = inMs > 0 ? `next in ${formatDuration(inMs)}` : 'due now';
  const status = hb.escalated ? '⚠️ escalated — last ping went unanswered' : '✅ healthy';
  await frontend.sendText(msg.conversationId, `💓 every ${formatDuration(hb.intervalMs)} (${nextIn}) — ${status}`);
});

frontend.onCommand('unheartbeat', async (msg) => {
  if (!heartbeats.disable(msg.conversationId)) {
    throw new Error('No heartbeat in this conversation. /heartbeat <interval> to add one.');
  }
  complaints.forget(`heartbeat:${msg.conversationId}`);
  await frontend.sendText(msg.conversationId, '🛑 Heartbeat cancelled.');
});

async function shutdown(): Promise<void> {
  console.log('\n[broker] shutting down…');
  // Before stopAll: a tick landing mid-shutdown would push a prompt into a
  // session being torn down.
  clearInterval(loopScheduler);
  clearInterval(heartbeatScheduler);
  // Same reason, plus one of its own: the heartbeat stops here, so a hook that
  // asks during shutdown sees a dead broker and falls through to its session
  // immediately rather than waiting out a deadline nobody is left to meet.
  clearInterval(askWatcher);
  await sessions.stopAll();
  await frontend.stop();
  process.exit(0);
}

process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());

await frontend.start();
console.log(`[broker] up. state: ${config.stateFile}`);

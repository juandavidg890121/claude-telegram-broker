import { basename, resolve } from 'node:path';
import { homedir } from 'node:os';
import { statSync } from 'node:fs';
import {
  getSessionMessages,
  listSessions,
  type SDKSessionInfo,
} from '@anthropic-ai/claude-agent-sdk';
import { config } from './config.js';
import { Registry } from './registry.js';
import { PERMISSION_MODES, SessionManager } from './sessions.js';
import { TelegramFrontend } from './telegram.js';
import type { Frontend, Inbound } from './frontend.js';

const registry = new Registry(config.stateFile);
const frontend: Frontend = new TelegramFrontend();

const sessions = new SessionManager({
  registry,
  emit: (conversationId, text) => frontend.sendText(conversationId, text),
  confirm: (conversationId, ask) => frontend.askPermission(conversationId, ask),
});

frontend.onCommand('help', async (msg) => {
  await frontend.sendText(
    msg.conversationId,
    [
      '/new [--path <dir>] [name…] — start a session in a new topic.',
      '    /new fix the login bug        → default directory, topic "fix the login bug"',
      '    /new --path ~/code/repo       → topic "repo"',
      '    /new --path ~/code/repo tests → topic "tests"',
      '/sessions — sessions this broker manages',
      '/all [n] [--offset k] [--all] — every Claude session on this machine, brokered or not',
      `    /all              → the ${ALL_PAGE} most recent, grouped by project`,
      '    /all 50           → the 50 most recent',
      `    /all --offset ${ALL_PAGE}    → the next page`,
      '    /all --all        → all of them, across several messages',
      '/history [n] — last n messages of this session',
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

frontend.onCommand('sessions', async (msg) => {
  const entries = registry.list();
  const body = entries.length
    ? entries
        .map((e) => `• ${e.title} — ${e.cwd}\n  ${e.sessionId ?? '(not started yet)'}`)
        .join('\n')
    : 'No sessions yet. Use /new.';
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
  await sessions.interrupt(msg.conversationId);
  await frontend.sendText(msg.conversationId, '⏹️ Interrupted.');
});

frontend.onCommand('stop', async (msg) => {
  await sessions.stop(msg.conversationId);
  await frontend.sendText(msg.conversationId, '🔴 Session stopped. Send a message to resume it.');
});

frontend.onMessage(async (msg: Inbound) => {
  if (!registry.get(msg.conversationId)) {
    // First contact in a conversation we've never seen: adopt it with defaults
    // so the user can just start talking.
    sessions.register(msg.conversationId, config.defaultCwd, 'default');
  }
  await sessions.send(msg.conversationId, msg.text);
});

async function shutdown(): Promise<void> {
  console.log('\n[broker] shutting down…');
  await sessions.stopAll();
  await frontend.stop();
  process.exit(0);
}

process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());

await frontend.start();
console.log(`[broker] up. state: ${config.stateFile}`);

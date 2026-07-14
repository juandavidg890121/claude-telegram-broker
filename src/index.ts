import { resolve } from 'node:path';
import { getSessionMessages, listSessions } from '@anthropic-ai/claude-agent-sdk';
import { config } from './config.js';
import { Registry } from './registry.js';
import { SessionManager } from './sessions.js';
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
      '/new [path] — start a session (new topic if a forum group is configured)',
      '/sessions — sessions this broker manages',
      '/all — every Claude session on this machine, brokered or not',
      '/history [n] — last n messages of this session',
      '/stop — end this session (the transcript survives; the next message resumes it)',
      '/interrupt — stop what Claude is doing right now',
      'Anything else is sent to Claude as a message.',
    ].join('\n'),
  );
});

frontend.onCommand('new', async (msg, args) => {
  const cwd = resolve(args.trim() || config.defaultCwd);
  const title = cwd.split('/').filter(Boolean).pop() ?? 'session';
  const conversationId = await frontend.createConversation(title, msg);
  sessions.register(conversationId, cwd, title);
  await frontend.sendText(conversationId, `🟢 Session ready in \`${cwd}\`. Send a message to start.`);
});

frontend.onCommand('sessions', async (msg) => {
  const entries = registry.list();
  const body = entries.length
    ? entries
        .map((e) => `• ${e.title} — ${e.cwd}\n  ${e.sessionId ?? '(not started yet)'}`)
        .join('\n')
    : 'No sessions yet. Use /new.';
  await frontend.sendText(msg.conversationId, body);
});

frontend.onCommand('all', async (msg) => {
  // Claude already keeps its own session index on disk — read it rather than
  // maintaining a second, drift-prone copy.
  const all = await listSessions({ limit: 15 });
  const body = all.length
    ? all.map((s) => `• ${s.sessionId}\n  ${s.summary ?? '(no summary)'}`).join('\n')
    : 'No sessions found on this machine.';
  await frontend.sendText(msg.conversationId, body);
});

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

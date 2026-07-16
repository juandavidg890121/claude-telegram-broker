/**
 * Stop hook, doing two jobs for /watch at the one moment a hook can act on a
 * live session — the end of a turn.
 *
 * 1. Mirror this turn's reply out to the Telegram topic watching this session.
 *    Every turn, including ones typed in VS Code: seeing what Claude is doing in
 *    a session you left open is the point of /watch.
 * 2. Arm the poller if the topic is watching but nothing is listening. This is
 *    what makes /watch a single step for a session that was *already open* when
 *    you watched it — SessionStart fired long before, so this is the only hook
 *    left that can notice.
 *
 * Where to send is looked up, never hardcoded: the broker's state file already
 * maps conversation -> session id. If no entry matches this session, the hook
 * does nothing at all — an unwatched session producing no Telegram traffic and
 * no stray Monitors is correct, not a failure.
 *
 * Install (the token stays out of settings.json — see README):
 *   "Stop": [{ "hooks": [{ "type": "command", "command":
 *     "<repo>/node_modules/.bin/tsx --env-file-if-exists=<repo>/.env <repo>/scripts/mirror/stop-hook.ts" }] }]
 */
import { chunkify } from '../../src/chunk.js';
import { findWatched } from '../../src/broker-state.js';
import { heartbeatFresh } from '../../src/mirror.js';
import { armInstruction } from '../../src/watch-arm.js';

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

function target(conversationId: string): { chatId: string; threadId?: number } {
  const [chatId, thread] = conversationId.split(':');
  const threadId = Number(thread);
  return { chatId, threadId: threadId > 0 ? threadId : undefined };
}

async function send(token: string, chatId: string, threadId: number | undefined, text: string): Promise<void> {
  const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, message_thread_id: threadId }),
  });
  if (!response.ok) throw new Error(`sendMessage ${response.status}: ${await response.text()}`);
}

async function main(): Promise<void> {
  const payload = JSON.parse(await readStdin()) as {
    session_id?: string;
    last_assistant_message?: string;
    stop_hook_active?: boolean;
  };

  const sessionId = payload.session_id;
  if (!sessionId) return;

  const entry = findWatched(sessionId);
  if (!entry) return; // Not watched: no mirroring, no arming, no noise.

  await mirrorReply(entry.conversationId, payload.last_assistant_message?.trim());

  // Arm only if nothing is listening. `stop_hook_active` means this turn is
  // itself the continuation a Stop hook asked for — injecting again from inside
  // it would ask forever if arming failed, turning a missing poller into a
  // session that will not stop.
  if (!heartbeatFresh(sessionId) && !payload.stop_hook_active) {
    console.log(
      JSON.stringify({
        hookSpecificOutput: { hookEventName: 'Stop', additionalContext: armInstruction(sessionId) },
      }),
    );
  }
}

async function mirrorReply(conversationId: string, text: string | undefined): Promise<void> {
  // The hook input already carries the reply text, so there is no transcript to
  // open and parse. The SDK documents this field as existing precisely for that.
  if (!text) return;

  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    // Loud, because this is the difference between "not watched" and
    // "misconfigured", and the silent version of this bug is unfindable: the
    // mirror simply never speaks and nothing anywhere says why.
    console.error(
      '[stop-hook] this session is watched from Telegram but TELEGRAM_BOT_TOKEN is unset — ' +
        'no reply was mirrored. Point the hook at the broker .env (see README).',
    );
    return;
  }

  const { chatId, threadId } = target(conversationId);
  for (const chunk of chunkify(text)) {
    try {
      await send(token, chatId, threadId, chunk);
    } catch (error) {
      // Best-effort: a Telegram hiccup must never fail the real session's turn.
      console.error(`[stop-hook] ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

await main();

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
import { homedir } from 'node:os';
import { join } from 'node:path';
import { chunkify } from '../../src/chunk.js';
import { findWatched } from '../../src/broker-state.js';
import { heartbeatFresh } from '../../src/mirror.js';
import { armInstruction } from '../../src/watch-arm.js';
import { quotaSuffix, checkAlert } from '../../src/quota.js';
import { readStdin, target, send, notify } from '../../src/hook-telegram.js';
import { PongStore } from '../../src/heartbeat.js';

// Not imported from src/config.js: config.ts's module load throws unless the
// broker's full startup contract (TELEGRAM_ALLOWED_USERS, etc.) is satisfied
// — see hook-telegram.ts's own file-header comment for why every hook grows
// its own copy of the couple of things it actually needs instead of pulling
// that in. Same env var and default index.ts's config.pongFile resolves to.
const pongFile = process.env.BROKER_PONG_FILE ?? join(homedir(), '.claude-telegram-broker-pong.json');

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

  await mirrorReply(entry.conversationId, sessionId, payload.last_assistant_message?.trim());

  await mirrorAlert(entry.conversationId);

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

async function mirrorReply(conversationId: string, sessionId: string, text: string | undefined): Promise<void> {
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

  // Chunked here rather than through notify(): the suffix has to be appended
  // *after* the split so it always lands on the last chunk. Adding it before
  // would let chunkify push it onto a page of its own — which is the separate
  // message this design exists to avoid.
  const { chatId, threadId } = target(conversationId);
  const chunks = chunkify(text);
  // It rides along inside the chunk because chunkify's MAX_LEN leaves ~90
  // characters of head room under Telegram's real 4096 cap — enough for this
  // line, which is why it does not need a message of its own.
  const suffix = await quotaSuffix();
  if (suffix && chunks.length > 0) chunks[chunks.length - 1] += suffix;

  // Tracks whether ANY chunk actually reached Telegram — a heartbeat pong
  // (src/heartbeat.ts) is only recorded on real success, not merely on
  // having tried. A multi-chunk message could partially fail; even one
  // successful chunk is real evidence the mirror pipeline works.
  let sentOk = false;
  for (const chunk of chunks) {
    try {
      await send(token, chatId, threadId, chunk);
      sentOk = true;
    } catch (error) {
      // Best-effort: a Telegram hiccup must never fail the real session's turn.
      console.error(`[stop-hook] ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  if (sentOk) new PongStore(pongFile).recordPong(sessionId);
}

/**
 * A message of its own, unlike the suffix: crossing 90% is news, and news
 * appended to the tail of a reply you were not reading is news you miss.
 *
 * Silent when unwatched-but-untokened, deliberately — mirrorReply already said
 * that loudly this turn, and saying it twice per turn trains you to ignore it.
 */
async function mirrorAlert(conversationId: string): Promise<void> {
  const alert = await checkAlert();
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!alert || !token) return;

  await notify(conversationId, token, alert, 'stop-hook');
}

await main();

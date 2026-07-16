/**
 * The watched side of /watch. Armed as a persistent Monitor *by the user*, via
 * the telegram-broker:watch skill, inside the session being watched.
 *
 * Arming is the user's explicit act on purpose. An earlier design had a
 * SessionStart hook ask the model to arm this via additionalContext — but then
 * the whole liveness signal rests on the model choosing to comply with a note it
 * was handed at startup. When it doesn't, the heartbeat never appears and the
 * broker concludes the session is dead while it is very much alive. A safety
 * property cannot depend on "the model probably will".
 *
 * Each loop:
 *   1. Touch the heartbeat. Its mtime is the only liveness signal the broker
 *      reads — no pid, so nothing to go stale-but-reused. Monitor stops when the
 *      session ends, which stops the touching, which is exactly the signal we
 *      want and costs nothing to maintain.
 *   2. Claim pending messages and print one compact JSON line each. Monitor
 *      turns every stdout line into one event, so the line must stay single —
 *      hence JSON, which escapes the newlines a phone message will contain.
 *
 * Usage: poller.ts <session-id>
 */
import { claimMessages, touchHeartbeat } from '../../src/mirror.js';

const sessionId = process.argv[2];
if (!sessionId) {
  console.error('usage: poller.ts <session-id>');
  process.exit(1);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// eslint-disable-next-line no-constant-condition
while (true) {
  try {
    touchHeartbeat(sessionId);
    for (const message of claimMessages(sessionId)) {
      console.log(JSON.stringify({ from: 'telegram', text: message.text, at: message.at }));
    }
  } catch (error) {
    // A transient fs hiccup must not kill the watch: dying here would look to
    // the broker exactly like the session ending, and silently stop delivery.
    console.error(`[poller] ${error instanceof Error ? error.message : String(error)}`);
  }
  await sleep(1000);
}

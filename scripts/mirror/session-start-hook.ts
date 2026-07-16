/**
 * SessionStart hook: if a Telegram topic is already watching this session, arm
 * its poller without the user having to ask twice.
 *
 * Covers the session that gets opened (or resumed) *after* /watch. The other
 * direction — /watch on a session that is already open — is the Stop hook's job,
 * because SessionStart has long since fired by then.
 *
 * Says nothing for sessions no topic is watching, which is almost all of them:
 * this hook is installed globally and must stay invisible until it is relevant.
 *
 * Install (see README):
 *   "SessionStart": [{ "hooks": [{ "type": "command", "command":
 *     "<repo>/node_modules/.bin/tsx <repo>/scripts/mirror/session-start-hook.ts" }] }]
 */
import { findWatched } from '../../src/broker-state.js';
import { armInstruction } from '../../src/watch-arm.js';

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

const payload = JSON.parse(await readStdin()) as { session_id?: string };
const sessionId = payload.session_id;

if (sessionId && findWatched(sessionId)) {
  console.log(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext: armInstruction(sessionId),
      },
    }),
  );
}

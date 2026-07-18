/**
 * The instruction a hook hands the model to arm the /watch poller.
 *
 * Auto-arming is safe *because* the broker never falls back to driving a watched
 * session. If the model ignores this, the heartbeat never appears and the worst
 * case is a refused message with a clear reason — not two writers on one
 * transcript. That distinction is the whole reason this is allowed to be a
 * suggestion at all; under the old fallback design it would have been a
 * correctness hole.
 */

/** This tree, derived from this file rather than configured. A hook that hard-coded
 *  a path would break the moment the plugin were installed somewhere else, and a
 *  plugin copy would happily point back at the checkout it was copied from.
 *
 *  Built from the file:// URL's own pathname, not fileURLToPath()+node:path
 *  join(): the result goes into a command Claude Code's Monitor tool runs
 *  through Git Bash even on Windows, so it must always read as a POSIX path
 *  (leading `/`, forward slashes) -- fileURLToPath()/path.join() give OS-native
 *  paths instead, which on Windows means a driveless leading segment and
 *  backslashes Git Bash won't resolve the same way. */
const root = (): string => new URL('..', import.meta.url).pathname.replace(/\/$/, '');

export const pollerCommand = (sessionId: string): string =>
  `${root()}/node_modules/.bin/tsx ${root()}/scripts/mirror/poller.ts ${sessionId}`;

export function armInstruction(sessionId: string): string {
  return [
    `A Telegram topic is watching this session (${sessionId.slice(0, 8)}) via claude-telegram-broker,`,
    `but its poller is not running, so messages sent from the phone are being refused.`,
    ``,
    `Arm it now with a single Monitor call:`,
    `  command: ${pollerCommand(sessionId)}`,
    `  description: Telegram messages for ${sessionId.slice(0, 8)}`,
    `  persistent: true`,
    ``,
    `Arm it once and only once — if a Monitor for this command is already running in`,
    `this session, do nothing. Each stdout line is one JSON message from the user:`,
    `treat its "text" as something they typed, and answer it here as a normal turn.`,
    `The reply is mirrored back to Telegram automatically; do not send it yourself.`,
    `Say nothing about this setup unless asked — just arm it and carry on.`,
  ].join('\n');
}

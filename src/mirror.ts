import { randomBytes } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, renameSync, statSync, utimesSync, writeFileSync, closeSync, openSync } from 'node:fs';
import { join } from 'node:path';
import { CLAUDE_HOME } from './claude-home.js';

/**
 * The file handoff behind /watch: Telegram writes messages here, a poller armed
 * inside the watched session claims them.
 *
 * Everything is keyed by session id. That is not tidiness — a single shared
 * inbox is a correctness bug. Two Claude sessions open at once would claim each
 * other's messages (whoever's poller ran first wins), and one session ending
 * would clear the other's liveness. The session id in the path makes both
 * impossible rather than unlikely.
 */
export const MIRROR_ROOT = process.env.BROKER_MIRROR_DIR ?? join(CLAUDE_HOME, 'telegram_mirror');

/**
 * How long a heartbeat may go untouched before its session counts as gone. The
 * poller touches once a second, so this tolerates four missed cycles.
 *
 * This is a lease, and a lease always has false positives — a suspended laptop
 * looks identical to a crashed one. That is survivable *only* because being
 * wrong here is safe by construction: a stale heartbeat makes the broker refuse
 * the message, never take the session over. Nothing on this path can produce a
 * second writer, so the timeout is a UX knob, not a safety boundary.
 */
export const HEARTBEAT_STALE_MS = 5000;

/**
 * How long an undelivered message stays worth delivering.
 *
 * The inbox is files on disk, so it survives anything — including a reboot with
 * messages still in it. Without an expiry, reopening that session tomorrow
 * delivers yesterday's question as if it had just been asked, and Claude answers
 * it into a conversation that has moved on. Dropping it is the lesser evil: the
 * sender is told, and can just ask again.
 */
export const MESSAGE_TTL_MS = 60 * 60 * 1000;

export type InboxMessage = { text: string; from: 'telegram'; at: string };

export const mirrorDir = (sessionId: string): string => join(MIRROR_ROOT, sessionId);
export const inboxDir = (sessionId: string): string => join(mirrorDir(sessionId), 'inbox');
export const processedDir = (sessionId: string): string => join(mirrorDir(sessionId), 'processed');
export const heartbeatPath = (sessionId: string): string => join(mirrorDir(sessionId), 'heartbeat');

export function touchHeartbeat(sessionId: string): void {
  mkdirSync(mirrorDir(sessionId), { recursive: true });
  const path = heartbeatPath(sessionId);
  try {
    const now = new Date();
    utimesSync(path, now, now);
  } catch {
    closeSync(openSync(path, 'w'));
  }
}

export function heartbeatFresh(sessionId: string, now: number = Date.now()): boolean {
  try {
    return now - statSync(heartbeatPath(sessionId)).mtimeMs < HEARTBEAT_STALE_MS;
  } catch {
    return false;
  }
}

/**
 * Ordering comes from the filename, so the timestamp is zero-padded (plain
 * Date.now() would sort wrong the day it gains a digit) and carries a sequence
 * number: two messages in the same millisecond are ordinary on a phone, and
 * without it their relative order would be down to a random suffix.
 */
let sequence = 0;

export function writeInboxMessage(sessionId: string, text: string): string {
  const dir = inboxDir(sessionId);
  mkdirSync(dir, { recursive: true });

  const name = `${String(Date.now()).padStart(14, '0')}-${String(sequence++).padStart(6, '0')}-${randomBytes(3).toString('hex')}.json`;
  const message: InboxMessage = { text, from: 'telegram', at: new Date().toISOString() };

  // Write under a dotted name the poller's *.json filter ignores, then rename
  // into place: rename is atomic, so a message is never half-visible.
  const tmp = join(dir, `.${name}.tmp`);
  writeFileSync(tmp, JSON.stringify(message));
  renameSync(tmp, join(dir, name));
  return name;
}

/**
 * Take ownership of every pending message, oldest first.
 *
 * The rename *is* the claim, and it happens before the read: whoever renames
 * successfully owns the file, and everyone else gets ENOENT and skips it. That
 * makes delivery exactly-once even with two pollers racing — which is worth
 * defending against, because nothing stops a session from arming the watch
 * twice.
 */
export function claimMessages(sessionId: string, now: number = Date.now()): InboxMessage[] {
  const inbox = inboxDir(sessionId);
  const processed = processedDir(sessionId);
  mkdirSync(inbox, { recursive: true });
  mkdirSync(processed, { recursive: true });

  const claimed: InboxMessage[] = [];
  for (const name of readdirSync(inbox).filter((n) => n.endsWith('.json')).sort()) {
    const destination = join(processed, name);
    try {
      renameSync(join(inbox, name), destination);
    } catch {
      continue; // Another poller claimed it first.
    }
    try {
      const message = JSON.parse(readFileSync(destination, 'utf8')) as InboxMessage;
      // Claimed either way, so a stale message is retired rather than left to be
      // reconsidered on every future cycle.
      if (now - Date.parse(message.at) < MESSAGE_TTL_MS) claimed.push(message);
    } catch {
      // Unparseable message: it is already out of the inbox, so it cannot wedge
      // the queue. Dropping it beats crashing the poller that delivers the rest.
    }
  }
  return claimed;
}

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Read-only view of the broker's registry, for the hooks.
 *
 * The hooks run inside the watched session — a different process from the
 * broker, started by Claude Code, with none of the broker's env. So they cannot
 * import config.ts (its module-level validation throws without the broker's
 * variables) and must not keep their own copy of the mapping. Reading the one
 * file the broker already maintains keeps a single source of truth.
 */
export type WatchedEntry = {
  conversationId: string;
  sessionId?: string;
  watch?: boolean;
};

export const stateFile = (): string =>
  process.env.BROKER_STATE_FILE ?? join(homedir(), '.claude-telegram-broker.json');

/** The Telegram conversation watching this session, if any. */
export function findWatched(sessionId: string): WatchedEntry | undefined {
  try {
    const entries = JSON.parse(readFileSync(stateFile(), 'utf8')) as WatchedEntry[];
    return entries.find((entry) => entry.sessionId === sessionId && entry.watch);
  } catch {
    // No state file, or unreadable: nothing is watched. Hooks stay silent rather
    // than announce the broker's absence into an unrelated session.
    return undefined;
  }
}

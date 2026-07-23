import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CLAUDE_HOME } from './claude-home.js';
import { MIRROR_ROOT } from './mirror.js';

/**
 * Live quota % (5h/7d) via Anthropic API response headers -- there is no
 * dedicated "get quota" endpoint, but any authenticated request to
 * /v1/messages returns rate-limit info in headers regardless of body, so this
 * fires a near-zero-cost max_tokens:1 call on haiku and reads those headers.
 *
 * Ported from the Python original (~/.claude/telegram_mirror/quota_check.py,
 * itself ported from the now-retired telegram_bridge/bridge.py) onto the new
 * stop-hook.ts mirror path -- same cache format, same behavior.
 *
 * Nothing here may throw. It runs inside the Stop hook of a real session, where
 * a rejected promise ends the turn with an error -- a quota *decoration* taking
 * down the session it decorates is a far worse bug than showing no quota at
 * all. So every exported entry point fails open, and the three decisions worth
 * getting right (freshness, header parsing, alert hysteresis) are pure
 * functions, testable without a network or a home directory.
 */

// Claude Code's file, at Claude Code's path -- deliberately not derived from
// MIRROR_ROOT, which happens to sit inside CLAUDE_HOME today but moves the
// moment anyone sets BROKER_MIRROR_DIR.
const CREDS_PATH = join(CLAUDE_HOME, '.credentials.json');
// The cache, on the other hand, is the broker's own state, so it follows the
// mirror wherever you put it.
const CACHE_PATH = join(MIRROR_ROOT, 'quota_cache.json');
const ALERT_STATE_PATH = join(MIRROR_ROOT, 'quota_alert_state.json');
const CACHE_TTL_SECONDS = 300;
const ALERT_THRESHOLD = 90;

export type Quota = {
  five_h_pct: number | null;
  seven_d_pct: number | null;
  /** Unix seconds when each window rolls over, straight from the reset headers. */
  five_h_reset: number | null;
  seven_d_reset: number | null;
  /** The API's own verdict per window: 'allowed' while it will still serve you. */
  five_h_status: string | null;
  seven_d_status: string | null;
  fetched_at: number;
};
export type AlertState = { five_h_alerted: boolean; seven_d_alerted: boolean };
type Reading = Quota & { five_h_pct: number; seven_d_pct: number };
export type QuotaWindow = { label: string; pct: number; reset: number | null; status: string | null };

function readJson<T>(path: string): T | undefined {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch {
    return undefined;
  }
}

function writeJson(path: string, value: unknown): void {
  try {
    mkdirSync(MIRROR_ROOT, { recursive: true });
    writeFileSync(path, JSON.stringify(value));
  } catch {
    // A cache that will not persist costs one extra API call next turn. That is
    // not worth interrupting a session over.
  }
}

function accessToken(): string {
  const creds = JSON.parse(readFileSync(CREDS_PATH, 'utf8'));
  return creds.claudeAiOauth.accessToken;
}

/** A percentage, or null when the header is missing or not a number. */
function pct(value: string | null): number | null {
  if (value === null) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.round(parsed * 100) : null;
}

/** A unix-seconds timestamp, or null when the header is missing or not a number. */
function epoch(value: string | null): number | null {
  if (value === null) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function parseQuota(headers: Headers, now: number = Date.now()): Quota {
  return {
    five_h_pct: pct(headers.get('anthropic-ratelimit-unified-5h-utilization')),
    seven_d_pct: pct(headers.get('anthropic-ratelimit-unified-7d-utilization')),
    five_h_reset: epoch(headers.get('anthropic-ratelimit-unified-5h-reset')),
    seven_d_reset: epoch(headers.get('anthropic-ratelimit-unified-7d-reset')),
    five_h_status: headers.get('anthropic-ratelimit-unified-5h-status'),
    seven_d_status: headers.get('anthropic-ratelimit-unified-7d-status'),
    fetched_at: now / 1000,
  };
}

/** The two windows as one shape, so nothing below has to say "5h" twice. */
function windows(quota: Reading): QuotaWindow[] {
  return [
    { label: '5h', pct: quota.five_h_pct, reset: quota.five_h_reset ?? null, status: quota.five_h_status ?? null },
    { label: '7d', pct: quota.seven_d_pct, reset: quota.seven_d_reset ?? null, status: quota.seven_d_status ?? null },
  ];
}

/**
 * "at 2:30 PM (in 1h 20min)" -- the clock time answers "can I go to lunch", the
 * relative one answers it without making you work out what timezone the broker
 * thinks it is in.
 *
 * The locale is pinned rather than left to the host: an unset LANG makes
 * toLocaleTimeString fall back to whatever the machine happens to be, so the
 * same broker would phrase the same reading differently on two boxes. English
 * for now, like every other string the broker sends; a BROKER_LOCALE is the
 * obvious place to hang a language setting when one is wanted.
 */
export function resetPhrase(reset: number | null, now: number = Date.now()): string {
  if (reset === null) return 'shortly (the API did not say when)';
  const clock = new Date(reset * 1000).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  const minutes = Math.max(0, Math.round((reset * 1000 - now) / 60_000));
  // Days, because the weekly window resets two or three days out and "in 50h
  // 16min" is a number you have to sit and convert before it means anything.
  const relative =
    minutes >= 1_440
      ? `${Math.floor(minutes / 1_440)}d ${Math.floor((minutes % 1_440) / 60)}h`
      : minutes >= 60
        ? `${Math.floor(minutes / 60)}h ${minutes % 60}min`
        : `${minutes}min`;
  return `at ${clock} (in ${relative})`;
}

export function fresh(quota: Quota, now: number = Date.now()): boolean {
  const age = now / 1000 - quota.fetched_at;
  // A negative age is a cache written "in the future" by a clock jump. Counting
  // that as fresh would pin a stale reading until the clock caught up.
  return age >= 0 && age < CACHE_TTL_SECONDS;
}

/** Both windows known, or nothing: half a reading is not worth a line of text. */
export function usable(quota: Quota | undefined): quota is Reading {
  return quota?.five_h_pct != null && quota.seven_d_pct != null;
}

export function quotaLine(quota: Reading): string {
  return `\n\n[quota 5h ${quota.five_h_pct}% / 7d ${quota.seven_d_pct}%]`;
}

async function fetchLive(): Promise<Quota> {
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken()}`,
      'Content-Type': 'application/json',
      'anthropic-version': '2023-06-01',
      'anthropic-beta': 'oauth-2025-04-20',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5',
      max_tokens: 1,
      messages: [{ role: 'user', content: 'hi' }],
    }),
  });
  return parseQuota(response.headers);
}

/** Cached (300s) quota, or undefined on any failure -- fails open. */
async function getQuota(): Promise<Quota | undefined> {
  try {
    const cached = readJson<Quota>(CACHE_PATH);
    if (cached && fresh(cached)) return cached;
    const live = await fetchLive();
    writeJson(CACHE_PATH, live);
    return live;
  } catch {
    return undefined;
  }
}

export async function quotaSuffix(): Promise<string> {
  const quota = await getQuota();
  return usable(quota) ? quotaLine(quota) : '';
}

/**
 * Alert the first time a window crosses ALERT_THRESHOLD, then stay silent until
 * it drops back below -- an hour spent at 96% is one warning, not one per turn.
 *
 * Pure, and returns the next state instead of mutating the old one: hysteresis
 * is the only thing in this file with a memory, which makes it the only thing
 * that can be quietly wrong for hours before anyone notices.
 */
export function decideAlert(
  quota: Reading,
  state: AlertState,
  now: number = Date.now(),
): { message?: string; state: AlertState } {
  const next = { ...state };
  const lines: string[] = [];
  const [fiveH, sevenD] = windows(quota);

  if (fiveH.pct >= ALERT_THRESHOLD) {
    if (!next.five_h_alerted) lines.push(`5h quota at ${fiveH.pct}% — resets ${resetPhrase(fiveH.reset, now)}`);
    next.five_h_alerted = true;
  } else {
    next.five_h_alerted = false;
  }

  if (sevenD.pct >= ALERT_THRESHOLD) {
    if (!next.seven_d_alerted) lines.push(`7d quota at ${sevenD.pct}% — resets ${resetPhrase(sevenD.reset, now)}`);
    next.seven_d_alerted = true;
  } else {
    next.seven_d_alerted = false;
  }

  // One line per window now that each carries a reset time: joined with "y" on
  // one line, the two clock times read as one confusing sentence.
  return { message: lines.length ? `⚠️ ${lines.join('\n⚠️ ')}` : undefined, state: next };
}

export async function checkAlert(): Promise<string | undefined> {
  const quota = await getQuota();
  if (!usable(quota)) return undefined;

  const previous = readJson<AlertState>(ALERT_STATE_PATH) ?? {
    five_h_alerted: false,
    seven_d_alerted: false,
  };
  const { message, state } = decideAlert(quota, previous);
  writeJson(ALERT_STATE_PATH, state);
  return message;
}

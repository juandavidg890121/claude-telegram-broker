import { readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Live quota % (5h/7d) via Anthropic API response headers -- there is no
 * dedicated "get quota" endpoint, but any authenticated request to
 * /v1/messages returns rate-limit info in headers regardless of body, so this
 * fires a near-zero-cost max_tokens:1 call on haiku and reads those headers.
 *
 * Ported from the Python original (~/.claude/telegram_mirror/quota_check.py,
 * itself ported from the now-retired telegram_bridge/bridge.py) onto the new
 * stop-hook.ts mirror path -- same cache files, same format, same behavior.
 */

const CREDS_PATH = join(homedir(), '.claude', '.credentials.json');
const CACHE_PATH = join(homedir(), '.claude', 'telegram_mirror', 'quota_cache.json');
const ALERT_STATE_PATH = join(homedir(), '.claude', 'telegram_mirror', 'quota_alert_state.json');
const CACHE_TTL_SECONDS = 300;
const ALERT_THRESHOLD = 95;

type Quota = { five_h_pct: number | null; seven_d_pct: number | null; fetched_at: number };
type AlertState = { five_h_alerted: boolean; seven_d_alerted: boolean };

function readJson<T>(path: string): T | undefined {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch {
    return undefined;
  }
}

function accessToken(): string {
  const creds = JSON.parse(readFileSync(CREDS_PATH, 'utf8'));
  return creds.claudeAiOauth.accessToken;
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
  const fiveH = response.headers.get('anthropic-ratelimit-unified-5h-utilization');
  const sevenD = response.headers.get('anthropic-ratelimit-unified-7d-utilization');
  return {
    five_h_pct: fiveH ? Math.round(Number(fiveH) * 100) : null,
    seven_d_pct: sevenD ? Math.round(Number(sevenD) * 100) : null,
    fetched_at: Date.now() / 1000,
  };
}

/** Cached (300s) quota, or undefined on any failure -- fails open. */
async function getQuota(): Promise<Quota | undefined> {
  try {
    const cached = readJson<Quota>(CACHE_PATH);
    if (cached && Date.now() / 1000 - cached.fetched_at < CACHE_TTL_SECONDS) return cached;
    const fresh = await fetchLive();
    writeFileSync(CACHE_PATH, JSON.stringify(fresh));
    return fresh;
  } catch {
    return undefined;
  }
}

export async function quotaSuffix(): Promise<string> {
  const q = await getQuota();
  if (!q || q.five_h_pct == null || q.seven_d_pct == null) return '';
  return `\n\n[cuota 5h ${q.five_h_pct}% / 7d ${q.seven_d_pct}%]`;
}

/**
 * Returns an alert message the first time either window crosses
 * ALERT_THRESHOLD, then stays silent until that window drops back below it
 * (so a long stretch at 96% doesn't re-alert every message).
 */
export async function checkAlert(): Promise<string | undefined> {
  const q = await getQuota();
  if (!q || q.five_h_pct == null || q.seven_d_pct == null) return undefined;

  const state: AlertState = readJson<AlertState>(ALERT_STATE_PATH) ?? {
    five_h_alerted: false,
    seven_d_alerted: false,
  };

  const lines: string[] = [];
  if (q.five_h_pct >= ALERT_THRESHOLD && !state.five_h_alerted) {
    lines.push(`cuota 5h al ${q.five_h_pct}%`);
    state.five_h_alerted = true;
  } else if (q.five_h_pct < ALERT_THRESHOLD) {
    state.five_h_alerted = false;
  }

  if (q.seven_d_pct >= ALERT_THRESHOLD && !state.seven_d_alerted) {
    lines.push(`cuota 7d al ${q.seven_d_pct}%`);
    state.seven_d_alerted = true;
  } else if (q.seven_d_pct < ALERT_THRESHOLD) {
    state.seven_d_alerted = false;
  }

  writeFileSync(ALERT_STATE_PATH, JSON.stringify(state));

  if (lines.length === 0) return undefined;
  return `⚠️ ${lines.join(' y ')}`;
}

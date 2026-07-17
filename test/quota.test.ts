/**
 * The quota decoration, tested where it can actually be wrong.
 *
 * Two things here have teeth. The hysteresis has memory, so it is the one part
 * that can be wrong for hours before anyone notices — a missed reset means the
 * 95% warning never fires again, silently, and the failure looks exactly like
 * "we just haven't hit 95% since". And the file paths must follow
 * BROKER_MIRROR_DIR, because a hardcoded home path writes to a directory nobody
 * promised exists.
 *
 * Offline like the rest of the suite: seeding a *fresh* cache file is what
 * keeps getQuota from ever reaching for the network, so these tests never see
 * an API, a token, or a real home directory.
 */
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, it } from 'node:test';

// Must be set before the import below: MIRROR_ROOT is read once, at module load.
const root = join(mkdtempSync(join(tmpdir(), 'quota-')), 'mirror');
process.env.BROKER_MIRROR_DIR = root;

const { parseQuota, fresh, decideAlert, quotaLine, checkAlert, usable } = await import('../src/quota.js');
type Quota = Awaited<ReturnType<typeof parseQuota>>;

const CACHE = join(root, 'quota_cache.json');
const STATE = join(root, 'quota_alert_state.json');
const NOW = 1_700_000_000_000;

/** A cache entry the code will consider fresh, so no fetch is attempted. */
const seedCache = (five: number | null, seven: number | null): void => {
  mkdirSync(root, { recursive: true });
  writeFileSync(CACHE, JSON.stringify({ five_h_pct: five, seven_d_pct: seven, fetched_at: Date.now() / 1000 }));
};

const quota = (five: number, seven: number): Quota & { five_h_pct: number; seven_d_pct: number } => ({
  five_h_pct: five,
  seven_d_pct: seven,
  fetched_at: NOW / 1000,
});

const headers = (entries: Record<string, string>): Headers => new Headers(entries);

describe('parseQuota', () => {
  it('turns the utilization fraction into a percentage', () => {
    const q = parseQuota(
      headers({
        'anthropic-ratelimit-unified-5h-utilization': '0.42',
        'anthropic-ratelimit-unified-7d-utilization': '0.075',
      }),
      NOW,
    );
    assert.equal(q.five_h_pct, 42);
    assert.equal(q.seven_d_pct, 8); // 7.5 rounds up, not truncates.
    assert.equal(q.fetched_at, NOW / 1000);
  });

  it('reads an untouched window as 0, not as "no reading"', () => {
    // 0 and null mean different things downstream — one prints "5h 0%", the
    // other drops the line entirely — and 0 is the falsy value most likely to
    // get conflated with absence.
    const q = parseQuota(headers({ 'anthropic-ratelimit-unified-5h-utilization': '0' }), NOW);
    assert.equal(q.five_h_pct, 0);
  });

  it('reports a missing or unparseable header as null, not NaN', () => {
    // Number('unknown') is NaN, and NaN survives Math.round: without the finite
    // check the null guards downstream all pass and Telegram gets "5h NaN%".
    const q = parseQuota(headers({ 'anthropic-ratelimit-unified-5h-utilization': 'unknown' }), NOW);
    assert.equal(q.five_h_pct, null);
    assert.equal(q.seven_d_pct, null);
  });
});

describe('usable', () => {
  it('rejects a half reading', () => {
    assert.equal(usable({ five_h_pct: 40, seven_d_pct: null, fetched_at: 0 }), false);
    assert.equal(usable(undefined), false);
    assert.equal(usable({ five_h_pct: 0, seven_d_pct: 0, fetched_at: 0 }), true);
  });
});

describe('quotaLine', () => {
  it('is a suffix: it starts with the blank line that detaches it from the reply', () => {
    assert.equal(quotaLine(quota(42, 8)), '\n\n[cuota 5h 42% / 7d 8%]');
  });
});

describe('fresh', () => {
  it('holds a reading for the TTL and lets it go after', () => {
    const q = quota(10, 10);
    assert.equal(fresh(q, NOW + 299_000), true);
    assert.equal(fresh(q, NOW + 301_000), false);
  });

  it('refuses a cache written in the future', () => {
    // A clock jump backwards writes exactly this. Reading age as "small" would
    // pin the stale value until the clock caught up — minutes, or hours.
    assert.equal(fresh(quota(10, 10), NOW - 60_000), false);
  });
});

describe('decideAlert', () => {
  const quiet = { five_h_alerted: false, seven_d_alerted: false };

  it('says nothing below the threshold', () => {
    const { message, state } = decideAlert(quota(94, 10), quiet);
    assert.equal(message, undefined);
    assert.deepEqual(state, quiet);
  });

  it('alerts on the crossing and remembers it', () => {
    const { message, state } = decideAlert(quota(96, 10), quiet);
    assert.equal(message, '⚠️ cuota 5h al 96%');
    assert.equal(state.five_h_alerted, true);
  });

  it('stays silent while the window remains over the threshold', () => {
    const first = decideAlert(quota(96, 10), quiet);
    const second = decideAlert(quota(98, 10), first.state);
    assert.equal(second.message, undefined);
    assert.equal(second.state.five_h_alerted, true);
  });

  it('rearms once the window drops back below', () => {
    const alerted = decideAlert(quota(96, 10), quiet).state;
    const recovered = decideAlert(quota(20, 10), alerted);
    assert.equal(recovered.message, undefined);
    assert.equal(recovered.state.five_h_alerted, false);

    // The point of rearming: the *next* crossing must warn again.
    assert.equal(decideAlert(quota(97, 10), recovered.state).message, '⚠️ cuota 5h al 97%');
  });

  it('tracks the two windows independently', () => {
    const fiveOnly = decideAlert(quota(96, 10), quiet);
    assert.equal(fiveOnly.message, '⚠️ cuota 5h al 96%');

    // 7d crosses later; 5h is still high but already announced, so only the new
    // one speaks.
    const sevenLater = decideAlert(quota(97, 96), fiveOnly.state);
    assert.equal(sevenLater.message, '⚠️ cuota 7d al 96%');
  });

  it('joins both windows into one message when they cross together', () => {
    assert.equal(decideAlert(quota(95, 99), quiet).message, '⚠️ cuota 5h al 95% y cuota 7d al 99%');
  });

  it('treats the threshold itself as crossed', () => {
    assert.equal(decideAlert(quota(95, 10), quiet).message, '⚠️ cuota 5h al 95%');
  });

  it('does not mutate the state it was given', () => {
    const state = { ...quiet };
    decideAlert(quota(99, 99), state);
    assert.deepEqual(state, quiet);
  });
});

describe('checkAlert', () => {
  // The alert state is a file that outlives the process on purpose, which also
  // means it outlives the test that wrote it. Clear it, or one case's crossing
  // silences the next case's.
  beforeEach(() => rmSync(STATE, { force: true }));

  it('keeps its state beside the mirror state, under BROKER_MIRROR_DIR', async () => {
    seedCache(96, 10);

    assert.equal(await checkAlert(), '⚠️ cuota 5h al 96%');
    assert.ok(existsSync(STATE), 'alert state should live beside the mirror state');
    assert.deepEqual(JSON.parse(readFileSync(STATE, 'utf8')), { five_h_alerted: true, seven_d_alerted: false });

    // Persisted, so the next turn — a whole new hook process — stays quiet.
    assert.equal(await checkAlert(), undefined);
  });

  it('returns nothing when only one window is known', async () => {
    seedCache(99, null);
    assert.equal(await checkAlert(), undefined);
  });

  it('still delivers the alert when its state file cannot be written', async () => {
    seedCache(99, 99);
    chmodSync(root, 0o500);
    try {
      // Fails open, and above all does not throw: this runs inside a real
      // session's Stop hook, where a rejected promise ends the turn with an
      // error. A quota decoration must never take down what it decorates.
      assert.equal(await checkAlert(), '⚠️ cuota 5h al 99% y cuota 7d al 99%');
    } finally {
      chmodSync(root, 0o700);
    }
  });
});

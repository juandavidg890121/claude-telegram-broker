/**
 * The quota decoration, tested where it can actually be wrong.
 *
 * Two things here have teeth. The hysteresis has memory, so it is the one
 * part that can be wrong for hours before anyone notices — a missed reset means
 * the 90% warning never fires again, silently, and the failure looks exactly
 * like "we just haven't hit 90% since". And the file paths must follow
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

const { parseQuota, fresh, decideAlert, quotaLine, checkAlert, resetPhrase, usable } =
  await import('../src/quota.js');
type Quota = Awaited<ReturnType<typeof parseQuota>>;

const CACHE = join(root, 'quota_cache.json');
const STATE = join(root, 'quota_alert_state.json');
const NOW = 1_700_000_000_000;
/** 90 minutes past NOW, so the relative half of a reset phrase reads "1h 30min". */
const RESET = NOW / 1000 + 5_400;

/** A cache entry the code will consider fresh, so no fetch is attempted. */
const seedCache = (five: number | null, seven: number | null, extra: Partial<Quota> = {}): void => {
  mkdirSync(root, { recursive: true });
  writeFileSync(
    CACHE,
    JSON.stringify({ five_h_pct: five, seven_d_pct: seven, fetched_at: Date.now() / 1000, ...extra }),
  );
};

const quota = (five: number, seven: number, extra: Partial<Quota> = {}): Quota & { five_h_pct: number; seven_d_pct: number } => ({
  five_h_pct: five,
  seven_d_pct: seven,
  five_h_reset: RESET,
  seven_d_reset: RESET,
  five_h_status: 'allowed',
  seven_d_status: 'allowed',
  fetched_at: NOW / 1000,
  ...extra,
});

/** The exact phrase the code under test would render, so no test pins a timezone. */
const at = (reset: number | null = RESET): string => resetPhrase(reset, NOW);

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

  it('keeps the reset timestamps and statuses verbatim', () => {
    // Unix seconds, not milliseconds, and not scaled like the utilization is —
    // multiplying these by 100 would put every reset 5000 years out and every
    // "resets" line would still look plausible in Telegram.
    const q = parseQuota(
      headers({
        'anthropic-ratelimit-unified-5h-reset': '1784383800',
        'anthropic-ratelimit-unified-5h-status': 'rejected',
        'anthropic-ratelimit-unified-7d-reset': '1784556000',
        'anthropic-ratelimit-unified-7d-status': 'allowed',
      }),
      NOW,
    );
    assert.equal(q.five_h_reset, 1_784_383_800);
    assert.equal(q.seven_d_reset, 1_784_556_000);
    assert.equal(q.five_h_status, 'rejected');
    assert.equal(q.seven_d_status, 'allowed');
  });

  it('reports missing reset and status headers as null', () => {
    const q = parseQuota(headers({ 'anthropic-ratelimit-unified-5h-reset': 'soon' }), NOW);
    assert.equal(q.five_h_reset, null);
    assert.equal(q.five_h_status, null);
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
    assert.equal(usable(quota(40, 0, { seven_d_pct: null })), false);
    assert.equal(usable(undefined), false);
    assert.equal(usable(quota(0, 0)), true);
  });
});

describe('quotaLine', () => {
  it('is a suffix: it starts with the blank line that detaches it from the reply', () => {
    assert.equal(quotaLine(quota(42, 8)), '\n\n[quota 5h 42% / 7d 8%]');
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
    const { message, state } = decideAlert(quota(89, 10), quiet, NOW);
    assert.equal(message, undefined);
    assert.deepEqual(state, quiet);
  });

  it('alerts on the crossing, with when the window comes back', () => {
    const { message, state } = decideAlert(quota(96, 10), quiet, NOW);
    assert.equal(message, `⚠️ 5h quota at 96% — resets ${at()}`);
    assert.equal(state.five_h_alerted, true);
  });

  it('says so plainly when the API did not send a reset time', () => {
    // The alternative is a line that trails off after "resets", which reads
    // like the message got truncated rather than like the API was quiet.
    const { message } = decideAlert(quota(96, 10, { five_h_reset: null }), quiet, NOW);
    assert.equal(message, '⚠️ 5h quota at 96% — resets shortly (the API did not say when)');
  });

  it('stays silent while the window remains over the threshold', () => {
    const first = decideAlert(quota(96, 10), quiet, NOW);
    const second = decideAlert(quota(98, 10), first.state, NOW);
    assert.equal(second.message, undefined);
    assert.equal(second.state.five_h_alerted, true);
  });

  it('rearms once the window drops back below', () => {
    const alerted = decideAlert(quota(96, 10), quiet, NOW).state;
    const recovered = decideAlert(quota(20, 10), alerted, NOW);
    assert.equal(recovered.message, undefined);
    assert.equal(recovered.state.five_h_alerted, false);

    // The point of rearming: the *next* crossing must warn again.
    assert.equal(
      decideAlert(quota(97, 10), recovered.state, NOW).message,
      `⚠️ 5h quota at 97% — resets ${at()}`,
    );
  });

  it('tracks the two windows independently', () => {
    const fiveOnly = decideAlert(quota(96, 10), quiet, NOW);
    assert.equal(fiveOnly.message, `⚠️ 5h quota at 96% — resets ${at()}`);

    // 7d crosses later; 5h is still high but already announced, so only the new
    // one speaks.
    const sevenLater = decideAlert(quota(97, 96), fiveOnly.state, NOW);
    assert.equal(sevenLater.message, `⚠️ 7d quota at 96% — resets ${at()}`);
  });

  it('puts each window on its own line when they cross together', () => {
    // One line each, because the two reset times run together into nonsense
    // when they share a sentence.
    assert.equal(
      decideAlert(quota(95, 99), quiet, NOW).message,
      `⚠️ 5h quota at 95% — resets ${at()}\n⚠️ 7d quota at 99% — resets ${at()}`,
    );
  });

  it('treats the threshold itself as crossed, and the threshold is 90', () => {
    // The number that moved. 90 is the whole point of warning early: at 95 a
    // long turn can finish the window before you have read the message.
    assert.equal(decideAlert(quota(90, 10), quiet, NOW).message, `⚠️ 5h quota at 90% — resets ${at()}`);
  });

  it('does not mutate the state it was given', () => {
    const state = { ...quiet };
    decideAlert(quota(99, 99), state);
    assert.deepEqual(state, quiet);
  });
});

describe('resetPhrase', () => {
  it('gives both a clock time and a relative one', () => {
    // The clock time is timezone-dependent by design — it is the one a human
    // compares against their own watch — so the assertion pins the shape, and
    // the relative half, which is the part that must be arithmetically right.
    assert.match(at(), /^at \d{1,2}:\d{2}\s?(AM|PM) \(in 1h 30min\)$/);
  });

  it('drops the hours when there are none', () => {
    assert.match(resetPhrase(NOW / 1000 + 600, NOW), /\(in 10min\)$/);
  });

  it('counts the weekly window in days', () => {
    // The 7d window resets two or three days out, where "in 50h 16min" is a
    // number you have to sit and convert before it tells you anything.
    assert.match(resetPhrase(NOW / 1000 + 181_000, NOW), /\(in 2d 2h\)$/);
  });

  it('never counts backwards', () => {
    // A reset already in the past would otherwise render "en -12min", which
    // reads as a bug in the broker rather than as a stale reading.
    assert.match(resetPhrase(NOW / 1000 - 720, NOW), /\(in 0min\)$/);
  });
});

describe('checkAlert', () => {
  // The alert state is a file that outlives the process on purpose, which also
  // means it outlives the test that wrote it. Clear it, or one case's crossing
  // silences the next case's.
  beforeEach(() => rmSync(STATE, { force: true }));

  it('keeps its state beside the mirror state, under BROKER_MIRROR_DIR', async () => {
    seedCache(96, 10, { five_h_reset: Date.now() / 1000 + 5_400 });

    assert.match((await checkAlert()) ?? '', /^⚠️ 5h quota at 96% — resets at \d{1,2}:\d{2}\s?(AM|PM) \(in 1h 30min\)$/);
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
      assert.match((await checkAlert()) ?? '', /^⚠️ 5h quota at 99% .*\n⚠️ 7d quota at 99% /);
    } finally {
      chmodSync(root, 0o700);
    }
  });
});

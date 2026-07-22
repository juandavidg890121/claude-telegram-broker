/**
 * Scheduled prompts: parsing durations, persistence, and which loops are due.
 */
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import {
  LoopComplaints,
  LoopStore,
  MIN_INTERVAL_MS,
  formatDuration,
  parseDuration,
  startLoopScheduler,
  type Loop,
} from '../src/loops.js';

const dir = mkdtempSync(join(tmpdir(), 'broker-loops-'));

describe('parseDuration', () => {
  it('parses seconds, minutes, hours, days', () => {
    assert.equal(parseDuration('90s'), 90_000);
    assert.equal(parseDuration('30m'), 30 * 60_000);
    assert.equal(parseDuration('2h'), 2 * 3_600_000);
    assert.equal(parseDuration('1d'), 86_400_000);
  });

  it('rejects anything shorter than a minute — racing itself is a real risk', () => {
    assert.throws(() => parseDuration('30s'), /minimum/i);
  });

  it('rejects garbage with a usage hint rather than a bare NaN', () => {
    assert.throws(() => parseDuration('soon'), /isn't a duration/);
    assert.throws(() => parseDuration(''), /isn't a duration/);
  });

  it('only suggests durations it will actually accept', () => {
    // The hint used to read "Use e.g. 30m, 2h, 1d, 45s" while rejecting 45s as
    // under the minimum: type a bad duration, follow the advice, get a second
    // error. Every example it offers has to survive being fed back in.
    let hint: Error | undefined;
    try {
      parseDuration('soon');
    } catch (error) {
      hint = error as Error;
    }
    const suggestions = hint?.message.match(/\d+[smhd]/g) ?? [];
    assert.ok(suggestions.length > 0, 'the hint should suggest something');
    for (const suggestion of suggestions) {
      assert.doesNotThrow(() => parseDuration(suggestion), `the hint offers "${suggestion}"`);
    }
  });

  it('names the minimum using the same formatter it prints everywhere else', () => {
    assert.throws(() => parseDuration('30s'), new RegExp(formatDuration(MIN_INTERVAL_MS)));
  });
});

describe('formatDuration', () => {
  it('picks the largest whole unit', () => {
    assert.equal(formatDuration(86_400_000), '1d');
    assert.equal(formatDuration(3_600_000), '1h');
    assert.equal(formatDuration(60_000), '1m');
    assert.equal(formatDuration(45_000), '45s');
  });
});

describe('LoopStore', () => {
  it('persists across instances, keyed by file', () => {
    const file = join(dir, 'a.json');
    new LoopStore(file).add('-100:1', 60_000, 'ping');
    const reloaded = new LoopStore(file);
    assert.equal(reloaded.listFor('-100:1').length, 1);
    assert.equal(reloaded.listFor('-100:1')[0].prompt, 'ping');
  });

  it('starts empty when the file does not exist yet', () => {
    const store = new LoopStore(join(dir, 'does-not-exist.json'));
    assert.deepEqual(store.listFor('-100:1'), []);
  });

  it('scopes listFor to one conversation', () => {
    const store = new LoopStore(join(dir, 'b.json'));
    store.add('-100:1', 60_000, 'a');
    store.add('-100:2', 60_000, 'b');
    assert.equal(store.listFor('-100:1').length, 1);
    assert.equal(store.listFor('-100:2').length, 1);
  });

  it('remove only affects the owning conversation, not a guessed id elsewhere', () => {
    const store = new LoopStore(join(dir, 'c.json'));
    const loop = store.add('-100:1', 60_000, 'a');
    assert.equal(store.remove('-100:2', loop.id), false, 'wrong conversation cannot cancel it');
    assert.equal(store.listFor('-100:1').length, 1, 'still there');
    assert.equal(store.remove('-100:1', loop.id), true);
    assert.equal(store.listFor('-100:1').length, 0);
  });

  it('edit replaces interval and prompt, and reschedules from now', () => {
    const store = new LoopStore(join(dir, 'd.json'));
    const loop = store.add('-100:1', 60_000, 'a');
    const before = Date.now();
    const updated = store.edit('-100:1', loop.id, 2 * 60_000, 'b');
    assert.equal(updated?.intervalMs, 2 * 60_000);
    assert.equal(updated?.prompt, 'b');
    assert.ok((updated?.nextFireAt ?? 0) >= before + 2 * 60_000);
  });

  it('edit on an unknown id returns undefined, does not throw', () => {
    const store = new LoopStore(join(dir, 'e.json'));
    assert.equal(store.edit('-100:1', 'nope', 60_000, 'x'), undefined);
  });

  it('takeDue returns only loops whose time has come, and reschedules them', () => {
    const store = new LoopStore(join(dir, 'f.json'));
    const loop = store.add('-100:1', 60_000, 'due-soon');
    assert.equal(store.takeDue(Date.now()).length, 0, 'not due yet, first fire is one interval out');

    const due = store.takeDue(Date.now() + 61_000);
    assert.equal(due.length, 1);
    assert.equal(due[0].id, loop.id);

    // Rescheduled: immediately re-checking at the same "now" finds nothing due.
    assert.equal(store.takeDue(Date.now() + 61_000).length, 0);
  });

  it('reschedules from the fire time, so a loop does not drift later every pass', () => {
    const store = new LoopStore(join(dir, 'g.json'));
    store.add('-100:1', 60_000, 'hourly-ish');

    // Ticks land on a 30s grid, as the scheduler's do. If nextFireAt were
    // advanced by anything but the interval, the gaps would grow.
    const fires: number[] = [];
    const start = Date.now();
    for (let tick = 1; tick <= 40; tick++) {
      const now = start + tick * 30_000;
      if (store.takeDue(now).length) fires.push(now);
    }

    assert.equal(fires.length, 20, 'a 1m loop over 20m of ticks fires 20 times');
    const gaps = fires.slice(1).map((at, i) => at - fires[i]);
    assert.deepEqual([...new Set(gaps)], [60_000], 'every gap is exactly the interval');
  });

  it('replaces the file rather than overwriting it in place', () => {
    // Atomicity is invisible from the outside — you cannot assert "was never
    // half-written" without catching it mid-write — but the *mechanism* leaves a
    // fingerprint. rename() swaps in a new file, so the inode changes; a plain
    // writeFileSync reuses the existing one and truncates it, which is the
    // window a kill lands in.
    //
    // It matters because the constructor reads truncated JSON as "no loops" and
    // the next add() overwrites the remains: every scheduled loop gone,
    // silently. takeDue() flushes on every tick with work, so that window
    // reopens every 30 seconds for as long as the broker runs.
    const file = join(dir, 'atomic.json');
    const store = new LoopStore(file);
    store.add('-100:1', 3_600_000, 'check the deploy queue');
    const first = statSync(file).ino;

    store.add('-100:1', 86_400_000, 'daily report');
    assert.notEqual(statSync(file).ino, first, 'each flush must land as a rename, not an in-place write');

    // And the rename cleans up after itself rather than leaving temp files.
    assert.equal(existsSync(`${file}.tmp`), false);
    assert.equal(new LoopStore(file).listFor('-100:1').length, 2);
  });

  it('reads a file that is corrupt anyway as empty rather than crashing the broker', () => {
    // Belt and braces: whatever else happens to that file, the broker starts.
    const file = join(dir, 'corrupt.json');
    writeFileSync(file, '[{"id":"abc","conv');
    assert.deepEqual(new LoopStore(file).listFor('-100:1'), []);
  });
});

describe('LoopComplaints', () => {
  it('says nothing when the prompt landed', () => {
    const complaints = new LoopComplaints();
    assert.equal(complaints.shouldReport('a1', 'delivered'), false);
  });

  it('reports the first miss', () => {
    const complaints = new LoopComplaints();
    assert.equal(complaints.shouldReport('a1', 'not-listening'), true);
  });

  it('stays quiet while it goes on missing', () => {
    // The point. A 30m loop against a closed VS Code window would otherwise
    // paste the same paragraph into the topic 48 times a day, forever.
    const complaints = new LoopComplaints();
    complaints.shouldReport('a1', 'not-listening');
    assert.equal(complaints.shouldReport('a1', 'not-listening'), false);
    assert.equal(complaints.shouldReport('a1', 'not-listening'), false);
  });

  it('rearms once it lands, so the next outage is news again', () => {
    // Without this the loop warns you once ever: reopen the session, close it a
    // week later, and it fails in silence.
    const complaints = new LoopComplaints();
    complaints.shouldReport('a1', 'not-listening');
    assert.equal(complaints.shouldReport('a1', 'delivered'), false);
    assert.equal(complaints.shouldReport('a1', 'not-listening'), true, 'the second outage is worth saying');
  });

  it('keeps loops apart', () => {
    const complaints = new LoopComplaints();
    assert.equal(complaints.shouldReport('a1', 'not-listening'), true);
    assert.equal(complaints.shouldReport('b2', 'not-listening'), true, 'a different loop has its own say');
  });

  it('forgets a cancelled loop, so a reused id does not inherit its silence', () => {
    const complaints = new LoopComplaints();
    complaints.shouldReport('a1', 'not-listening');
    complaints.forget('a1');
    assert.equal(complaints.shouldReport('a1', 'not-listening'), true);
  });
});

describe('startLoopScheduler', () => {
  const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

  it('delivers a due loop, and does not deliver one that is not due', async (t) => {
    // Date too, not just setInterval: takeDue() asks Date.now() what time it is,
    // so mocking only the timer advances the ticks against a clock that never moves.
    t.mock.timers.enable({ apis: ['setInterval', 'Date'] });
    const store = new LoopStore(join(dir, 'sched-a.json'));
    store.add('-100:1', 60_000, 'fire me');

    const delivered: Loop[] = [];
    const handle = startLoopScheduler(store, async (loop) => {
      delivered.push(loop);
    });

    // One tick, well before the loop is due.
    t.mock.timers.tick(30_000);
    await tick();
    assert.equal(delivered.length, 0, 'not due yet');

    // Past the interval.
    t.mock.timers.tick(30_000);
    t.mock.timers.tick(30_000);
    await tick();
    assert.equal(delivered.length, 1);
    assert.equal(delivered[0].prompt, 'fire me');
    clearInterval(handle);
  });

  it('hands over the whole loop, not just its text', async (t) => {
    // The deliverer needs the id to know whether this loop has already
    // complained, and the interval to say how often it will retry.
    // Date too, not just setInterval: takeDue() asks Date.now() what time it is,
    // so mocking only the timer advances the ticks against a clock that never moves.
    t.mock.timers.enable({ apis: ['setInterval', 'Date'] });
    const store = new LoopStore(join(dir, 'sched-b.json'));
    const added = store.add('-100:7', 60_000, 'ping');

    let seen: Loop | undefined;
    const handle = startLoopScheduler(store, async (loop) => {
      seen = loop;
    });
    t.mock.timers.tick(90_000);
    await tick();

    assert.equal(seen?.id, added.id);
    assert.equal(seen?.conversationId, '-100:7');
    assert.equal(seen?.intervalMs, 60_000);
    clearInterval(handle);
  });

  it('keeps ticking after a delivery throws', async (t) => {
    // A scheduler that dies on one bad delivery takes every other loop with it,
    // and nothing restarts it short of a broker restart.
    // Date too, not just setInterval: takeDue() asks Date.now() what time it is,
    // so mocking only the timer advances the ticks against a clock that never moves.
    t.mock.timers.enable({ apis: ['setInterval', 'Date'] });
    const store = new LoopStore(join(dir, 'sched-c.json'));
    store.add('-100:1', 60_000, 'boom');

    let calls = 0;
    const handle = startLoopScheduler(store, async () => {
      calls += 1;
      throw new Error('Telegram is down');
    });

    t.mock.timers.tick(90_000);
    await tick();
    assert.equal(calls, 1);

    t.mock.timers.tick(60_000);
    await tick();
    assert.equal(calls, 2, 'still firing after the first one threw');
    clearInterval(handle);
  });
});

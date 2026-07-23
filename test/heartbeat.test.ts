/**
 * Session<->Telegram liveness: the pong-marker file stop-hook.ts writes to
 * on every real successful mirror, and the per-conversation ping schedule
 * that reads it.
 *
 * NOT the same "heartbeat" as src/mirror.ts's heartbeatFresh — that one
 * tracks whether the /watch poller process is alive (5s staleness). This
 * one tracks whether the Stop-hook mirror is reaching Telegram at all
 * (minutes-scale). Two different liveness checks on two different
 * components that happen to share an English word.
 */
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import {
  HeartbeatStore,
  MIN_HEARTBEAT_INTERVAL_MS,
  PongStore,
  parseHeartbeatInterval,
  startHeartbeatScheduler,
  type Heartbeat,
} from '../src/heartbeat.js';

const dir = mkdtempSync(join(tmpdir(), 'broker-heartbeat-'));

describe('PongStore', () => {
  it('starts with no record for a session it has never heard of', () => {
    const store = new PongStore(join(dir, 'a.json'));
    assert.equal(store.lastPongAt('sess-1'), null);
  });

  it('records and reads back a pong', () => {
    const store = new PongStore(join(dir, 'b.json'));
    const before = Date.now();
    store.recordPong('sess-1');
    const at = store.lastPongAt('sess-1');
    assert.ok(at !== null && at >= before);
  });

  it('persists across instances, keyed by file', () => {
    const file = join(dir, 'c.json');
    new PongStore(file).recordPong('sess-1');
    const reloaded = new PongStore(file);
    assert.ok(reloaded.lastPongAt('sess-1') !== null);
  });

  it('an existing instance sees a pong written later by a different instance, without being reconstructed', () => {
    // The real-world shape of the bug this guards: the daemon constructs
    // exactly one PongStore at startup (index.ts's module-level `pongs`) and
    // keeps it for the process's entire lifetime, while stop-hook.ts writes
    // through a fresh instance every turn. Before this fix, lastPongAt()
    // read from an in-memory array captured once in the constructor, so the
    // daemon's long-lived instance never saw ANY pong recorded after its own
    // startup — every heartbeat escalation fired regardless of real,
    // successfully-recorded pongs, because the long-lived reader was
    // checking a frozen snapshot, not the file.
    const file = join(dir, 'cross-instance.json');
    const longLived = new PongStore(file);
    assert.equal(longLived.lastPongAt('sess-1'), null, 'nothing recorded yet');

    new PongStore(file).recordPong('sess-1'); // a separate, short-lived writer

    assert.ok(
      longLived.lastPongAt('sess-1') !== null,
      'the pre-existing instance must see the write without being reconstructed',
    );
  });

  it('keeps sessions apart', () => {
    const store = new PongStore(join(dir, 'd.json'));
    store.recordPong('sess-1');
    assert.equal(store.lastPongAt('sess-2'), null);
  });

  it('a later recordPong overwrites the earlier timestamp for the same session', async () => {
    const store = new PongStore(join(dir, 'e.json'));
    store.recordPong('sess-1');
    const first = store.lastPongAt('sess-1');
    await new Promise((resolve) => setTimeout(resolve, 5));
    store.recordPong('sess-1');
    const second = store.lastPongAt('sess-1');
    assert.ok(second !== null && first !== null && second > first);
  });

  it('replaces the file rather than overwriting it in place', () => {
    // Same atomicity concern as LoopStore: a plain writeFileSync truncates the
    // existing file in place, and a kill mid-write leaves the next read seeing
    // corrupt/truncated JSON. rename() swaps in a new file, changing the inode.
    const file = join(dir, 'atomic.json');
    const store = new PongStore(file);
    store.recordPong('sess-1');
    const first = statSync(file).ino;

    store.recordPong('sess-2');
    assert.notEqual(statSync(file).ino, first, 'each write must land as a rename, not an in-place write');
    assert.equal(existsSync(`${file}.tmp`), false);
  });

  it('reads a corrupt file as empty rather than crashing', () => {
    const file = join(dir, 'corrupt.json');
    writeFileSync(file, '[{"sessionId":"a');
    assert.equal(new PongStore(file).lastPongAt('sess-1'), null);
  });

  it('starts empty when the file does not exist yet', () => {
    const store = new PongStore(join(dir, 'does-not-exist.json'));
    assert.equal(store.lastPongAt('sess-1'), null);
  });
});

describe('parseHeartbeatInterval', () => {
  it('parses the same units as parseDuration', () => {
    assert.equal(parseHeartbeatInterval('30m'), 30 * 60_000);
    assert.equal(parseHeartbeatInterval('2h'), 2 * 3_600_000);
  });

  it('rejects anything shorter than 5 minutes — a loops.ts 1m interval is too aggressive here', () => {
    assert.throws(() => parseHeartbeatInterval('2m'), /minimum/i);
    assert.doesNotThrow(() => parseHeartbeatInterval('5m'));
  });

  it('has a 5-minute floor, distinct from loops.ts', () => {
    assert.equal(MIN_HEARTBEAT_INTERVAL_MS, 5 * 60_000);
  });
});

describe('HeartbeatStore', () => {
  it('starts with nothing enabled', () => {
    const store = new HeartbeatStore(join(dir, 'hb-a.json'));
    assert.equal(store.get('-100:1'), undefined);
  });

  it('enable schedules the first ping one interval out', () => {
    const store = new HeartbeatStore(join(dir, 'hb-b.json'));
    const before = Date.now();
    const hb = store.enable('-100:1', 10 * 60_000);
    assert.equal(hb.conversationId, '-100:1');
    assert.equal(hb.intervalMs, 10 * 60_000);
    assert.equal(hb.lastPingAt, null);
    assert.equal(hb.escalated, false);
    assert.ok(hb.nextPingAt >= before + 10 * 60_000);
  });

  it('a second enable on the same conversation replaces the first — one heartbeat per conversation', () => {
    const store = new HeartbeatStore(join(dir, 'hb-c.json'));
    store.enable('-100:1', 10 * 60_000);
    const replaced = store.enable('-100:1', 20 * 60_000);
    assert.equal(replaced.intervalMs, 20 * 60_000);
    assert.equal(store.get('-100:1')?.intervalMs, 20 * 60_000);
  });

  it('disable removes it, and reports whether there was anything to remove', () => {
    const store = new HeartbeatStore(join(dir, 'hb-d.json'));
    assert.equal(store.disable('-100:1'), false, 'nothing enabled yet');
    store.enable('-100:1', 10 * 60_000);
    assert.equal(store.disable('-100:1'), true);
    assert.equal(store.get('-100:1'), undefined);
  });

  it('persists across instances, keyed by file', () => {
    const file = join(dir, 'hb-e.json');
    new HeartbeatStore(file).enable('-100:1', 10 * 60_000);
    const reloaded = new HeartbeatStore(file);
    assert.equal(reloaded.get('-100:1')?.intervalMs, 10 * 60_000);
  });

  it('takeDue returns only what is due, and reschedules it', () => {
    const store = new HeartbeatStore(join(dir, 'hb-f.json'));
    store.enable('-100:1', 10 * 60_000);
    assert.equal(store.takeDue(Date.now()).length, 0, 'not due yet');

    const due = store.takeDue(Date.now() + 10 * 60_000 + 1_000);
    assert.equal(due.length, 1);
    assert.equal(due[0].conversationId, '-100:1');

    assert.equal(store.takeDue(Date.now() + 10 * 60_000 + 1_000).length, 0, 'rescheduled, not due again immediately');
  });

  it('markPinged records lastPingAt, the escalation flag, and missedPings', () => {
    const store = new HeartbeatStore(join(dir, 'hb-g.json'));
    store.enable('-100:1', 10 * 60_000);
    const before = Date.now();
    store.markPinged('-100:1', true, 2);
    const hb = store.get('-100:1');
    assert.ok((hb?.lastPingAt ?? 0) >= before);
    assert.equal(hb?.escalated, true);
    assert.equal(hb?.missedPings, 2);
  });

  it('enable() starts missedPings at 0 and it round-trips through the file', () => {
    const file = join(dir, 'hb-missed.json');
    const store = new HeartbeatStore(file);
    store.enable('-100:1', 10 * 60_000);
    assert.equal(store.get('-100:1')?.missedPings, 0);
    store.markPinged('-100:1', false, 1);
    assert.equal(new HeartbeatStore(file).get('-100:1')?.missedPings, 1);
  });

  it('reads a corrupt file as empty rather than crashing', () => {
    const file = join(dir, 'hb-corrupt.json');
    writeFileSync(file, '[{"conversationId":"a');
    assert.equal(new HeartbeatStore(file).get('-100:1'), undefined);
  });
});

describe('startHeartbeatScheduler', () => {
  const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

  it('delivers a due heartbeat, and does not deliver one that is not due', async (t) => {
    t.mock.timers.enable({ apis: ['setInterval', 'Date'] });
    const store = new HeartbeatStore(join(dir, 'hb-sched-a.json'));
    store.enable('-100:1', 10 * 60_000);

    const delivered: Heartbeat[] = [];
    const handle = startHeartbeatScheduler(store, async (hb) => {
      delivered.push(hb);
    });

    t.mock.timers.tick(5 * 60_000);
    await tick();
    assert.equal(delivered.length, 0, 'not due yet');

    t.mock.timers.tick(6 * 60_000);
    await tick();
    assert.equal(delivered.length, 1);
    assert.equal(delivered[0].conversationId, '-100:1');
    clearInterval(handle);
  });

  it('keeps ticking after a delivery throws', async (t) => {
    t.mock.timers.enable({ apis: ['setInterval', 'Date'] });
    const store = new HeartbeatStore(join(dir, 'hb-sched-b.json'));
    store.enable('-100:1', 10 * 60_000);

    let calls = 0;
    const handle = startHeartbeatScheduler(store, async () => {
      calls += 1;
      throw new Error('Telegram is down');
    });

    t.mock.timers.tick(11 * 60_000);
    await tick();
    assert.equal(calls, 1);

    t.mock.timers.tick(10 * 60_000);
    await tick();
    assert.equal(calls, 2, 'still firing after the first one threw');
    clearInterval(handle);
  });
});

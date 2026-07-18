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

import { PongStore } from '../src/heartbeat.js';

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

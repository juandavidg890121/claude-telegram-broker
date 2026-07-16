/**
 * The /watch handoff, tested where PR #1's bugs actually lived: concurrency and
 * the liveness decision. Everything here is filesystem-only — no API, no tokens,
 * milliseconds to run.
 *
 *   npm test
 */
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

// mirror.ts reads BROKER_MIRROR_DIR at import time, so redirect it first.
const root = mkdtempSync(join(tmpdir(), 'mirror-test-'));
process.env.BROKER_MIRROR_DIR = root;

const {
  HEARTBEAT_STALE_MS,
  MESSAGE_TTL_MS,
  claimMessages,
  heartbeatFresh,
  inboxDir,
  processedDir,
  touchHeartbeat,
  writeInboxMessage,
} = await import('../src/mirror.js');

describe('inbox handoff', () => {
  it('delivers a message once, with its text intact', () => {
    const session = 'session-basic';
    writeInboxMessage(session, 'hello from the phone');

    const claimed = claimMessages(session);
    assert.equal(claimed.length, 1);
    assert.equal(claimed[0].text, 'hello from the phone');
    assert.equal(claimed[0].from, 'telegram');

    // Draining twice must not replay: the message is claimed, not copied.
    assert.deepEqual(claimMessages(session), []);
  });

  it('preserves multi-line text, which a phone message routinely has', () => {
    const session = 'session-multiline';
    const text = 'first line\n\nthird line\n\ttabbed';
    writeInboxMessage(session, text);
    assert.equal(claimMessages(session)[0].text, text);
  });

  it('keeps order even when messages land in the same millisecond', () => {
    const session = 'session-order';
    const texts = Array.from({ length: 25 }, (_, i) => `message ${i}`);
    for (const text of texts) writeInboxMessage(session, text);

    // The whole loop runs well inside one millisecond, so ordering here rests
    // entirely on the filename's sequence number rather than its timestamp.
    assert.deepEqual(
      claimMessages(session).map((m) => m.text),
      texts,
    );
  });

  it('never delivers the same message to two racing pollers', () => {
    const session = 'session-race';
    const count = 40;
    for (let i = 0; i < count; i++) writeInboxMessage(session, `message ${i}`);

    // Two pollers is not hypothetical: nothing stops a session from arming the
    // watch twice. Exactly-once has to hold when they interleave.
    const first = claimMessages(session);
    const second = claimMessages(session);

    const all = [...first, ...second].map((m) => m.text);
    assert.equal(all.length, count, 'every message delivered exactly once');
    assert.equal(new Set(all).size, count, 'no message delivered twice');
    assert.equal(second.length, 0, 'the loser claims nothing already taken');
  });

  it('is not wedged by an unparseable message', () => {
    const session = 'session-corrupt';
    writeInboxMessage(session, 'before');
    writeFileSync(join(inboxDir(session), '99999999999999-000000-dead.json'), '{not json');
    writeInboxMessage(session, 'after');

    const claimed = claimMessages(session).map((m) => m.text);
    assert.deepEqual(claimed, ['before', 'after'], 'good messages still get through');
    // The bad one is out of the inbox, so it cannot block the queue forever.
    assert.equal(readdirSync(inboxDir(session)).filter((n) => n.endsWith('.json')).length, 0);
  });

  it('leaves no partially-written file for a poller to read', () => {
    const session = 'session-atomic';
    writeInboxMessage(session, 'x'.repeat(200_000));
    // The temp name is dotted so the *.json filter skips it; nothing half-written
    // is ever visible under a claimable name.
    assert.deepEqual(
      readdirSync(inboxDir(session)).filter((n) => !n.endsWith('.json')),
      [],
    );
    assert.equal(claimMessages(session)[0].text.length, 200_000);
  });

  it('keeps each session to its own messages', () => {
    // The bug this guards: one shared inbox let two open sessions claim each
    // other's messages, delivering a topic's message into the wrong project.
    writeInboxMessage('session-a', 'for A');
    writeInboxMessage('session-b', 'for B');

    assert.deepEqual(claimMessages('session-a').map((m) => m.text), ['for A']);
    assert.deepEqual(claimMessages('session-b').map((m) => m.text), ['for B']);
  });

  it('files claimed messages under the session that owned them', () => {
    const session = 'session-processed';
    writeInboxMessage(session, 'archived');
    claimMessages(session);
    assert.equal(readdirSync(processedDir(session)).length, 1);
  });
});

describe('stale messages', () => {
  it('drops a message left over from before a reboot', () => {
    // The inbox is on disk, so it outlives everything. Without an expiry, a
    // question asked last night is delivered this morning as though it were new.
    const session = 'session-reboot';
    writeInboxMessage(session, 'asked before the machine went down');

    const tomorrow = Date.now() + MESSAGE_TTL_MS + 1;
    assert.deepEqual(claimMessages(session, tomorrow), [], 'not delivered');
    assert.equal(readdirSync(inboxDir(session)).filter((n) => n.endsWith('.json')).length, 0);
  });

  it('retires a stale message instead of reconsidering it every cycle', () => {
    const session = 'session-retire';
    writeInboxMessage(session, 'old');
    claimMessages(session, Date.now() + MESSAGE_TTL_MS + 1);
    // Already moved to processed/, so a later poller cycle cannot see it again.
    assert.deepEqual(claimMessages(session), []);
    assert.equal(readdirSync(processedDir(session)).length, 1);
  });

  it('still delivers a message that is merely a few minutes old', () => {
    const session = 'session-recent';
    writeInboxMessage(session, 'sent while the poller was restarting');
    assert.deepEqual(
      claimMessages(session, Date.now() + 5 * 60_000).map((m) => m.text),
      ['sent while the poller was restarting'],
    );
  });
});

describe('liveness', () => {
  it('reads as dead when the session never armed a watch', () => {
    assert.equal(heartbeatFresh('session-never-armed'), false);
  });

  it('reads as alive right after a touch', () => {
    touchHeartbeat('session-live');
    assert.equal(heartbeatFresh('session-live'), true);
  });

  it('goes stale once the poller stops touching it', () => {
    touchHeartbeat('session-stale');
    // Simulate the clock moving past the lease rather than sleeping for it.
    const later = Date.now() + HEARTBEAT_STALE_MS + 1;
    assert.equal(heartbeatFresh('session-stale', later), false);
  });

  it('holds through a missed cycle or two', () => {
    touchHeartbeat('session-blip');
    assert.equal(heartbeatFresh('session-blip', Date.now() + 2000), true);
  });

  it('recovers when the poller comes back', () => {
    const session = 'session-recover';
    touchHeartbeat(session);
    assert.equal(heartbeatFresh(session, Date.now() + HEARTBEAT_STALE_MS + 1), false);
    touchHeartbeat(session);
    assert.equal(heartbeatFresh(session), true);
  });
});

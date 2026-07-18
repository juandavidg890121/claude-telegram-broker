/**
 * The file handoff that answers an AskUserQuestion in a watched session.
 *
 * The properties under test are the ones the design leans on rather than the
 * ones that are easy to assert: a claim is exactly-once even with two brokers, a
 * question that expired is retired rather than reconsidered forever, and a
 * closed ask can be told apart from an open one — that last is what stops a tap
 * from a pocket being written into a file nobody will ever read.
 *
 * BROKER_MIRROR_DIR is set before importing anything: mirror.ts reads it at
 * module scope, so a later assignment would land after MIRROR_ROOT is already
 * fixed and every test would quietly run against the real ~/.claude.
 */
import assert from 'node:assert/strict';
import { describe, it, before, beforeEach } from 'node:test';
import { mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = mkdtempSync(join(tmpdir(), 'broker-asks-'));
process.env.BROKER_MIRROR_DIR = root;

type Asks = typeof import('../src/asks.js');
let asks: Asks;

const SESSION = 'session-abc';

const request = (id: string, overrides: Partial<import('../src/asks.js').AskRequest> = {}) => ({
  id,
  sessionId: SESSION,
  questions: [{ question: 'Which library?', header: 'Library', options: [{ label: 'React' }, { label: 'Vue' }] }],
  at: new Date().toISOString(),
  expiresAt: Date.now() + 60_000,
  ...overrides,
});

before(async () => {
  asks = await import('../src/asks.js');
});

beforeEach(() => {
  rmSync(join(root, SESSION), { recursive: true, force: true });
});

describe('claimAskRequests', () => {
  it('hands back a written request', () => {
    asks.writeAskRequest(request('one'));
    const claimed = asks.claimAskRequests(SESSION);
    assert.equal(claimed.length, 1);
    assert.equal(claimed[0].id, 'one');
    assert.equal(claimed[0].questions[0].question, 'Which library?');
  });

  it('claims each request exactly once', () => {
    // Two brokers running by accident would otherwise both post the same
    // question to the same topic and race to answer it.
    asks.writeAskRequest(request('one'));
    assert.equal(asks.claimAskRequests(SESSION).length, 1);
    assert.equal(asks.claimAskRequests(SESSION).length, 0, 'a second claim finds nothing');
  });

  it('returns nothing for a session that has never asked', () => {
    assert.deepEqual(asks.claimAskRequests('never-asked'), []);
  });

  it('drops an expired request instead of putting it on a phone', () => {
    asks.writeAskRequest(request('stale', { expiresAt: Date.now() - 1 }));
    assert.deepEqual(asks.claimAskRequests(SESSION), []);
  });

  it('retires an expired request rather than reconsidering it every tick', () => {
    asks.writeAskRequest(request('stale', { expiresAt: Date.now() - 1 }));
    asks.claimAskRequests(SESSION);
    assert.equal(asks.askIsOpen(SESSION, 'stale'), false, 'nothing left to reconsider');
  });

  it('survives an unparseable request without wedging the ones behind it', () => {
    mkdirSync(asks.asksDir(SESSION), { recursive: true });
    writeFileSync(join(asks.asksDir(SESSION), 'broken.request.json'), '{not json');
    asks.writeAskRequest(request('good'));

    const claimed = asks.claimAskRequests(SESSION);
    assert.deepEqual(
      claimed.map((r) => r.id),
      ['good'],
    );
  });

  it('ignores a partly written request', () => {
    // writeAskRequest renames into place, so the .tmp name is never claimable.
    mkdirSync(asks.asksDir(SESSION), { recursive: true });
    writeFileSync(join(asks.asksDir(SESSION), 'half.request.json.tmp'), '{"id":"half"');
    assert.deepEqual(asks.claimAskRequests(SESSION), []);
  });
});

describe('answers', () => {
  it('round-trips what the broker wrote', () => {
    asks.writeAskAnswer(SESSION, 'one', { 'Which library?': 'React' });
    assert.deepEqual(asks.readAskAnswer(SESSION, 'one'), { 'Which library?': 'React' });
  });

  it('reads as unanswered until the broker writes', () => {
    assert.equal(asks.readAskAnswer(SESSION, 'one'), undefined);
  });

  it('waitForAnswer resolves as soon as the answer lands', async () => {
    const expiresAt = Date.now() + 5_000;
    const waiting = asks.waitForAnswer(SESSION, 'one', expiresAt, 10);
    setTimeout(() => asks.writeAskAnswer(SESSION, 'one', { q: 'Vue' }), 30);
    assert.deepEqual(await waiting, { q: 'Vue' });
  });

  it('waitForAnswer gives up at the deadline', async () => {
    assert.equal(await asks.waitForAnswer(SESSION, 'nobody', Date.now() + 50, 10), undefined);
  });

  it('waitForAnswer takes an answer that landed in the final gap', async () => {
    // The last poll and the deadline are not the same instant. Without the
    // re-read on the way out, an answer arriving between them is thrown away
    // while the hook reports that nobody replied.
    const expiresAt = Date.now() + 40;
    const waiting = asks.waitForAnswer(SESSION, 'late', expiresAt, 30);
    setTimeout(() => asks.writeAskAnswer(SESSION, 'late', { q: 'React' }), 35);
    assert.deepEqual(await waiting, { q: 'React' });
  });
});

describe('askIsOpen / clearAsk', () => {
  it('is open while the request is unclaimed', () => {
    asks.writeAskRequest(request('one'));
    assert.equal(asks.askIsOpen(SESSION, 'one'), true);
  });

  it('stays open once the broker has claimed it', () => {
    // The claim is the broker taking the question to the phone; the hook is
    // still waiting. Reading this as closed would drop every answer.
    asks.writeAskRequest(request('one'));
    asks.claimAskRequests(SESSION);
    assert.equal(asks.askIsOpen(SESSION, 'one'), true);
  });

  it('is closed once the hook has cleaned up', () => {
    asks.writeAskRequest(request('one'));
    asks.claimAskRequests(SESSION);
    asks.clearAsk(SESSION, 'one');
    assert.equal(asks.askIsOpen(SESSION, 'one'), false, 'a late tap must be recognisable as late');
  });

  it('leaves no files behind', () => {
    asks.writeAskRequest(request('one'));
    asks.claimAskRequests(SESSION);
    asks.writeAskAnswer(SESSION, 'one', { q: 'React' });
    asks.clearAsk(SESSION, 'one');
    assert.deepEqual(readdirSync(asks.asksDir(SESSION)), []);
  });

  it('is unbothered by clearing something that was never there', () => {
    assert.doesNotThrow(() => asks.clearAsk(SESSION, 'ghost'));
  });
});

describe('broker heartbeat', () => {
  it('reads as dead before the broker has ever run', () => {
    rmSync(asks.brokerHeartbeatPath(), { force: true });
    assert.equal(asks.brokerAlive(), false);
  });

  it('reads as alive right after a touch', () => {
    asks.touchBrokerHeartbeat();
    assert.equal(asks.brokerAlive(), true);
  });

  it('goes stale, so a stopped broker does not strand a hook for ten minutes', () => {
    asks.touchBrokerHeartbeat();
    assert.equal(asks.brokerAlive(Date.now() + 60_000), false);
  });
});

describe('startAskWatcher', () => {
  const settle = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  it('answers a claimed request', async () => {
    asks.writeAskRequest(request('one'));
    const watcher = asks.startAskWatcher(
      () => [SESSION],
      async () => ({ 'Which library?': 'React' }),
      10,
    );
    await settle(60);
    clearInterval(watcher);
    assert.deepEqual(asks.readAskAnswer(SESSION, 'one'), { 'Which library?': 'React' });
  });

  it('writes nothing when nobody answered', () => {
    // The hook's deadline is the authority on giving up. A written "no answer"
    // would race it and could beat a tap that was about to land.
    return (async () => {
      asks.writeAskRequest(request('one'));
      const watcher = asks.startAskWatcher(
        () => [SESSION],
        async () => undefined,
        10,
      );
      await settle(60);
      clearInterval(watcher);
      assert.equal(asks.readAskAnswer(SESSION, 'one'), undefined);
    })();
  });

  it('does not answer an ask the hook already abandoned', async () => {
    asks.writeAskRequest(request('one'));
    const watcher = asks.startAskWatcher(
      () => [SESSION],
      async () => {
        asks.clearAsk(SESSION, 'one'); // The hook timed out while we waited.
        return { q: 'React' };
      },
      10,
    );
    await settle(60);
    clearInterval(watcher);
    assert.equal(asks.readAskAnswer(SESSION, 'one'), undefined, 'no answer file for a closed ask');
  });

  it('asks once, not once per tick, while an answer is pending', async () => {
    asks.writeAskRequest(request('one'));
    let calls = 0;
    const watcher = asks.startAskWatcher(
      () => [SESSION],
      async () => {
        calls++;
        await settle(80);
        return { q: 'React' };
      },
      10,
    );
    await settle(60);
    clearInterval(watcher);
    assert.equal(calls, 1, 'a slow human must not produce a new question every tick');
  });

  it('keeps the broker heartbeat fresh while it runs', async () => {
    rmSync(asks.brokerHeartbeatPath(), { force: true });
    const watcher = asks.startAskWatcher(
      () => [],
      async () => undefined,
      10,
    );
    await settle(30);
    clearInterval(watcher);
    assert.equal(asks.brokerAlive(), true);
  });
});

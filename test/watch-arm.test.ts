/**
 * Auto-arming: which sessions a hook speaks up for, and what it says.
 *
 * The thing worth pinning down is the silence. These hooks are installed
 * globally and run in every Claude session on the machine, so "says nothing
 * unless this exact session is watched" is the property that keeps them from
 * being a nuisance — or from arming pollers nobody asked for.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

const dir = mkdtempSync(join(tmpdir(), 'broker-state-'));
const stateFile = join(dir, 'state.json');
process.env.BROKER_STATE_FILE = stateFile;

const { findWatched } = await import('../src/broker-state.js');
const { armInstruction, pollerCommand } = await import('../src/watch-arm.js');

const write = (entries: unknown[]) => writeFileSync(stateFile, JSON.stringify(entries));

describe('findWatched', () => {
  it('finds the conversation watching a session', () => {
    write([{ conversationId: '-100123:7', sessionId: 'abc', watch: true }]);
    assert.equal(findWatched('abc')?.conversationId, '-100123:7');
  });

  it('ignores a conversation that merely owns the session', () => {
    // An owned session is driven by the broker itself. Mirroring its replies
    // back would double every message, and arming a poller for it is nonsense.
    write([{ conversationId: '-100123:7', sessionId: 'abc' }]);
    assert.equal(findWatched('abc'), undefined);
  });

  it('says nothing about sessions it has never heard of', () => {
    write([{ conversationId: '-100123:7', sessionId: 'abc', watch: true }]);
    assert.equal(findWatched('some-other-session'), undefined);
  });

  it('stays quiet when there is no broker state at all', () => {
    process.env.BROKER_STATE_FILE = join(dir, 'does-not-exist.json');
    assert.equal(findWatched('abc'), undefined);
    process.env.BROKER_STATE_FILE = stateFile;
  });

  it('stays quiet on a corrupt state file rather than throwing into the session', () => {
    writeFileSync(stateFile, '{ this is not json');
    assert.equal(findWatched('abc'), undefined);
    write([{ conversationId: '-100123:7', sessionId: 'abc', watch: true }]);
  });

  it('picks the right entry out of a busy registry', () => {
    write([
      { conversationId: '-100:1', sessionId: 'owned-one' },
      { conversationId: '-100:2', sessionId: 'watched-one', watch: true },
      { conversationId: '-100:3', sessionId: 'watched-two', watch: true },
    ]);
    assert.equal(findWatched('watched-two')?.conversationId, '-100:3');
    assert.equal(findWatched('owned-one'), undefined);
  });
});

describe('armInstruction', () => {
  it('names an absolute poller command carrying the session id', () => {
    const command = pollerCommand('session-xyz');
    assert.ok(command.startsWith('/'), 'absolute, so it works from any cwd');
    assert.ok(command.includes('scripts/mirror/poller.ts'));
    assert.ok(command.endsWith(' session-xyz'));
  });

  it('points at its own tree, not a hardcoded checkout', () => {
    // A copied plugin must arm the copy's poller, not the tree it was copied from.
    // Same MSYS drive-letter conversion pollerCommand() itself applies -- a no-op
    // on Linux/macOS, where this pattern never matches to begin with.
    const here = new URL('..', import.meta.url).pathname
      .replace(/\/$/, '')
      .replace(/^\/([A-Za-z]):/, (_, drive: string) => `/${drive.toLowerCase()}`);
    assert.ok(pollerCommand('s').startsWith(here));
  });

  it('tells the model the things that make arming go wrong', () => {
    const text = armInstruction('session-xyz');
    assert.match(text, /persistent: true/, 'a non-persistent monitor dies mid-session');
    assert.match(text, /once and only once/i, 'two pollers race for the same messages');
    assert.match(text, /mirrored back to Telegram automatically/i, 'or it sends the reply twice');
    assert.ok(text.includes(pollerCommand('session-xyz')));
  });
});

/**
 * Reading a hook's payload from a pipe that may never close.
 *
 * The read used to end on EOF alone, which is fine everywhere the pipe closes
 * and a permanent hang where it does not — the suspected reason AskUserQuestion
 * never reaches Telegram on native Windows. The case that matters here is the
 * one with no `end` event at all: it must still resolve, and it must resolve
 * with the whole payload rather than whatever had arrived first.
 */
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { afterEach, describe, it } from 'node:test';
import { readStdin } from '../src/hook-stdin.js';

const real = Object.getOwnPropertyDescriptor(process, 'stdin')!;

/** Stand a pipe up as process.stdin. Restored after every test. */
function fakeStdin(): PassThrough {
  const stream = new PassThrough();
  Object.defineProperty(process, 'stdin', { value: stream, configurable: true });
  return stream;
}

afterEach(() => Object.defineProperty(process, 'stdin', real));

describe('readStdin', () => {
  it('resolves on a complete payload without waiting for EOF', async () => {
    // The Windows fix, and the whole point: no `end` is ever emitted here. The
    // pre-fix read hangs on this test forever.
    const stream = fakeStdin();
    const reading = readStdin();
    stream.write(JSON.stringify({ session_id: 'abc' }));
    assert.deepEqual(JSON.parse(await reading), { session_id: 'abc' });
  });

  it('waits for the rest when a payload arrives split across chunks', async () => {
    // A partial object parses as nothing, so an early resolve here would hand
    // the caller a truncated payload — worse than the hang it replaced.
    const stream = fakeStdin();
    const reading = readStdin();
    stream.write('{"session_id":"abc","tool_inp');
    stream.write('ut":{"questions":[]}}');
    assert.deepEqual(JSON.parse(await reading), { session_id: 'abc', tool_input: { questions: [] } });
  });

  it('still resolves at EOF, the way it always did', async () => {
    // POSIX closes the pipe, and that path must not regress.
    const stream = fakeStdin();
    const reading = readStdin();
    stream.end(JSON.stringify({ session_id: 'abc' }));
    assert.deepEqual(JSON.parse(await reading), { session_id: 'abc' });
  });

  it('resolves at EOF even when the input never parses', async () => {
    // Otherwise malformed input trades one silent hang for another. The caller
    // JSON.parses this and should see its own error.
    const stream = fakeStdin();
    const reading = readStdin();
    stream.end('not json');
    assert.equal(await reading, 'not json');
  });

  it('resolves empty on a pipe that closes with nothing in it', async () => {
    const stream = fakeStdin();
    const reading = readStdin();
    stream.end();
    assert.equal(await reading, '');
  });

  it('ignores anything written after the payload is complete', async () => {
    // A pipe held open may carry more; the hook has already answered.
    const stream = fakeStdin();
    const reading = readStdin();
    stream.write(JSON.stringify({ session_id: 'abc' }));
    const first = await reading;
    stream.write('trailing garbage');
    assert.deepEqual(JSON.parse(first), { session_id: 'abc' });
  });
});

/**
 * The Telegram plumbing every hook now shares.
 *
 * Worth pinning precisely *because* it is shared: this used to be three
 * byte-identical copies, and the failure mode of copies is that a fix lands in
 * one of them. Now a mistake here reaches every hook at once, which cuts both
 * ways.
 *
 * `send` and `notify` are exercised against a stubbed fetch — no network, in
 * keeping with the rest of the suite.
 */
import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { notify, send, target } from '../src/hook-telegram.js';
import { MAX_LEN } from '../src/chunk.js';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

type Call = { url: string; body: Record<string, unknown> };

/** Record every sendMessage, answering with `ok` or a failure. */
function stubFetch(ok = true): Call[] {
  const calls: Call[] = [];
  globalThis.fetch = (async (url: string, init: { body: string }) => {
    calls.push({ url: String(url), body: JSON.parse(init.body) });
    return ok
      ? new Response('{"ok":true}', { status: 200 })
      : new Response('Bad Request: chat not found', { status: 400 });
  }) as unknown as typeof fetch;
  return calls;
}

describe('target', () => {
  it('splits a forum conversation into chat and topic', () => {
    assert.deepEqual(target('-1001234567890:42'), { chatId: '-1001234567890', threadId: 42 });
  });

  it('treats thread 0 as no topic at all', () => {
    // The broker writes `<chat>:0` for a plain chat, and Telegram rejects
    // message_thread_id=0 rather than ignoring it — so this must be undefined,
    // not zero.
    assert.deepEqual(target('-1001234567890:0'), { chatId: '-1001234567890', threadId: undefined });
  });

  it('treats a missing thread as no topic', () => {
    assert.deepEqual(target('-1001234567890'), { chatId: '-1001234567890', threadId: undefined });
  });
});

describe('send', () => {
  it('posts the text to the bot API', async () => {
    const calls = stubFetch();
    await send('TOKEN123', '-100:42', 7, 'hello');

    assert.equal(calls.length, 1);
    assert.ok(calls[0].url.includes('/botTOKEN123/sendMessage'));
    assert.deepEqual(calls[0].body, { chat_id: '-100:42', text: 'hello', message_thread_id: 7 });
  });

  it('throws with the reason the API gave, on a non-2xx', async () => {
    stubFetch(false);
    // The status alone ("400") says nothing actionable; Telegram's body is what
    // names the actual problem.
    await assert.rejects(() => send('T', '-100', undefined, 'hi'), /400.*chat not found/);
  });

  it('does not retry a 4xx -- Telegram would reject it identically again', async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      return new Response('Bad Request: chat not found', { status: 400 });
    }) as unknown as typeof fetch;

    await assert.rejects(() => send('T', '-100', undefined, 'hi'));
    assert.equal(calls, 1);
  });

  it('retries once on a 5xx and succeeds if the retry lands', async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      return calls === 1 ? new Response('nope', { status: 502 }) : new Response('{"ok":true}', { status: 200 });
    }) as unknown as typeof fetch;

    await send('T', '-100', undefined, 'hi');
    assert.equal(calls, 2);
  });

  it('retries once on a network-level throw and succeeds if the retry lands', async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      if (calls === 1) throw new Error('ECONNRESET');
      return new Response('{"ok":true}', { status: 200 });
    }) as unknown as typeof fetch;

    await send('T', '-100', undefined, 'hi');
    assert.equal(calls, 2);
  });

  it('gives up after a network throw followed by a second failure', async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      throw new Error('ECONNRESET');
    }) as unknown as typeof fetch;

    await assert.rejects(() => send('T', '-100', undefined, 'hi'), /ECONNRESET/);
    assert.equal(calls, 2);
  });
});

describe('notify', () => {
  it('splits a long message into sendable chunks', async () => {
    const calls = stubFetch();
    await notify('-100:42', 'T', 'x'.repeat(MAX_LEN + 500), 'test-hook');

    assert.equal(calls.length, 2, 'one page over the limit means two messages');
    assert.ok((calls[0].body.text as string).length <= MAX_LEN);
  });

  it('swallows a Telegram failure instead of failing the turn', async () => {
    // The whole reason this wrapper exists. A hook runs inside a real session:
    // an unhandled rejection here ends someone's turn with an error over a
    // notification that did not arrive.
    stubFetch(false);
    await assert.doesNotReject(() => notify('-100:42', 'T', 'hi', 'test-hook'));
  });

  it('retries a transient failure on page one before moving to page two', async () => {
    let call = 0;
    const texts: string[] = [];
    globalThis.fetch = (async (_url: string, init: { body: string }) => {
      call += 1;
      texts.push(JSON.parse(init.body).text);
      // send()'s own retry absorbs this -- a transient failure on page one
      // must not silently truncate the message.
      return call === 1 ? new Response('nope', { status: 500 }) : new Response('{"ok":true}', { status: 200 });
    }) as unknown as typeof fetch;

    await notify('-100:42', 'T', 'y'.repeat(MAX_LEN + 500), 'test-hook');
    assert.equal(call, 3, 'page one: fail then retry, page two: one call');
    assert.equal(texts[0], texts[1], 'the retry resends the same page that failed');
  });

  it('keeps sending the rest after one chunk fails permanently', async () => {
    let call = 0;
    const calls: string[] = [];
    globalThis.fetch = (async (_url: string, init: { body: string }) => {
      calls.push(JSON.parse(init.body).text);
      call += 1;
      // A 4xx is not retried by send() itself, so this exercises notify's own
      // catch-and-continue: page two must still go out.
      return call === 1 ? new Response('nope', { status: 400 }) : new Response('{"ok":true}', { status: 200 });
    }) as unknown as typeof fetch;

    await notify('-100:42', 'T', 'y'.repeat(MAX_LEN + 500), 'test-hook');
    assert.equal(calls.length, 2);
  });
});

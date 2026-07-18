/**
 * When a typed message is an answer, and when it is just a message.
 *
 * The bar here is not "does Other work" — it is that nothing else gets eaten. A
 * message captured by mistake does not bounce and does not warn: it silently
 * becomes the answer to a multiple-choice question and steers the turn, and the
 * only evidence is that Claude did something you never asked for.
 */
import assert from 'node:assert/strict';
import { describe, it, beforeEach } from 'node:test';
import { FreeTextCapture, isTypedAnswer } from '../src/ask-capture.js';

const CONVO = '-100123:7';
const OTHER = '-100123:9';
const awaiting = { askId: 'ask1', questionIndex: 0 };

let capture: FreeTextCapture;
beforeEach(() => {
  capture = new FreeTextCapture();
});

describe('isTypedAnswer', () => {
  it('takes ordinary text', () => {
    assert.equal(isTypedAnswer('use the existing migration instead'), true);
  });

  it('refuses commands, so /stop still works while a question waits', () => {
    // The escape hatch. Without it, tapping Other and changing your mind leaves
    // a topic where the only way out is to answer the question.
    assert.equal(isTypedAnswer('/stop'), false);
    assert.equal(isTypedAnswer('  /interrupt'), false);
  });

  it('refuses an empty message rather than answering with nothing', () => {
    assert.equal(isTypedAnswer('   '), false);
    assert.equal(isTypedAnswer(''), false);
  });
});

describe('FreeTextCapture', () => {
  it('captures nothing until Other is tapped', () => {
    // The default state, and the one that matters most: every message in every
    // topic passes through this on its way to a session.
    assert.equal(capture.consume(CONVO, 'deploy the thing'), undefined);
  });

  it('captures the next message once armed', () => {
    capture.arm(CONVO, awaiting);
    assert.deepEqual(capture.consume(CONVO, 'use the existing migration'), awaiting);
  });

  it('captures once, then goes back to passing messages through', () => {
    capture.arm(CONVO, awaiting);
    capture.consume(CONVO, 'the answer');
    assert.equal(capture.consume(CONVO, 'and now a message for Claude'), undefined);
  });

  it('stays armed when the message was a command', () => {
    // Refusing to capture must not disarm: you typed /usage while thinking, and
    // the answer you type next still belongs to the question.
    capture.arm(CONVO, awaiting);
    assert.equal(capture.consume(CONVO, '/usage'), undefined);
    assert.deepEqual(capture.consume(CONVO, 'the answer'), awaiting);
  });

  it('only captures in the topic that armed it', () => {
    capture.arm(CONVO, awaiting);
    assert.equal(capture.consume(OTHER, 'a message in another session'), undefined);
  });

  it('re-arming points at the question you tapped last', () => {
    capture.arm(CONVO, awaiting);
    capture.arm(CONVO, { askId: 'ask1', questionIndex: 2 });
    assert.deepEqual(capture.consume(CONVO, 'the answer'), { askId: 'ask1', questionIndex: 2 });
  });

  it('forgets an ask that was settled some other way', () => {
    // Answered with a button, or timed out. Either way the next thing you type
    // is a message, and eating it would be the worst bug this file can have.
    capture.arm(CONVO, awaiting);
    capture.clearAsk('ask1');
    assert.equal(capture.consume(CONVO, 'a message for Claude'), undefined);
  });

  it('leaves other asks armed when one is cleared', () => {
    capture.arm(CONVO, awaiting);
    capture.arm(OTHER, { askId: 'ask2', questionIndex: 0 });
    capture.clearAsk('ask1');
    assert.deepEqual(capture.consume(OTHER, 'the answer'), { askId: 'ask2', questionIndex: 0 });
  });

  it('peeks without consuming', () => {
    capture.arm(CONVO, awaiting);
    assert.deepEqual(capture.peek(CONVO), awaiting);
    assert.deepEqual(capture.consume(CONVO, 'the answer'), awaiting, 'peeking did not use it up');
  });
});

/**
 * summarize(): the AskUserQuestion payload turned into the text a phone shows.
 *
 * Imported from src/, never redeclared here. A previous version of this file
 * defined its own copy of summarize and asserted against that — the hook could
 * be changed to `return 'garbage'` and all four tests stayed green. A test that
 * cannot fail is worse than no test: it reports coverage it does not have.
 *
 * The payload is typed by the SDK but arrives as JSON from a hook's stdin, so
 * the malformed cases below are real states, not paranoia.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { summarize } from '../src/ask-user-question.js';

const option = (label: string) => ({ label, description: `pick ${label}` });

describe('summarize', () => {
  it('shows the question and the options it is asking you to choose between', () => {
    // The options are the whole point: AskUserQuestion exists to make you pick.
    // "Which library?" with no choices tells you a decision is waiting without
    // telling you what it is.
    const text = summarize({
      questions: [{ question: 'Which library?', header: 'Library', options: [option('React'), option('Vue')] }],
    });
    assert.equal(text, '• [Library] Which library?\n  React / Vue');
  });

  it('puts each question on its own line', () => {
    const text = summarize({
      questions: [
        { question: 'Which library?', header: 'Library', options: [option('React'), option('Vue')] },
        { question: 'Which approach?', header: 'Approach', options: [option('Rewrite'), option('Patch')] },
      ],
    });
    assert.equal(
      text,
      '• [Library] Which library?\n  React / Vue\n• [Approach] Which approach?\n  Rewrite / Patch',
    );
  });

  it('says when several answers are allowed', () => {
    // Otherwise a multi-select reads as a single choice, and you go to VS Code
    // expecting the wrong shape of answer.
    const text = summarize({
      questions: [
        { question: 'Which features?', header: 'Features', multiSelect: true, options: [option('a'), option('b')] },
      ],
    });
    assert.equal(text, '• [Features] Which features? (pick any)\n  a / b');
  });

  it('caps a long option list rather than filling the screen', () => {
    const text = summarize({
      questions: [
        {
          question: 'Which one?',
          header: 'Pick',
          options: [option('a'), option('b'), option('c'), option('d'), option('e'), option('f')],
        },
      ],
    });
    assert.equal(text, '• [Pick] Which one?\n  a / b / c / d / +2 more');
  });

  it('drops the descriptions, keeping it glanceable', () => {
    // Four sentences of description turn a notification into something you have
    // to sit and read — and the answer has to be typed in VS Code regardless.
    const text = summarize({
      questions: [
        {
          question: 'Which?',
          header: 'H',
          options: [{ label: 'React', description: 'a long sentence explaining the trade-offs at length' }],
        },
      ],
    });
    assert.ok(!text.includes('trade-offs'));
    assert.ok(text.includes('React'));
  });

  it('survives a question with no options', () => {
    // The SDK requires options; a hook payload is still just JSON off a pipe.
    const text = summarize({ questions: [{ question: 'Continue?' } as never] });
    assert.equal(text, '• Continue?');
  });

  it('survives options that are not an array', () => {
    const text = summarize({ questions: [{ question: 'Continue?', options: 'nope' } as never] });
    assert.equal(text, '• Continue?');
  });

  it('says so rather than going out empty', () => {
    // A notification with a header and no body is worse than the silence this
    // feature replaces: you go and look, and there is nothing there.
    assert.equal(summarize({}), '(no question text available)');
    assert.equal(summarize({ questions: [] }), '(no question text available)');
    assert.equal(summarize(undefined), '(no question text available)');
    assert.equal(summarize({ questions: 'not an array' as never }), '(no question text available)');
  });

  it('names a question it cannot read rather than printing undefined', () => {
    const text = summarize({ questions: [{ header: 'Library' } as never] });
    assert.equal(text, '• [Library] (untitled)');
  });
});

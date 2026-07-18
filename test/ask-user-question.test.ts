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
import {
  askCallbackData,
  parseAskCallback,
  renderQuestion,
  summarize,
  toAnswers,
} from '../src/ask-user-question.js';
import type { AskQuestion } from '../src/asks.js';

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

/**
 * The answering half: what a question looks like when it has buttons, how a tap
 * survives the 64-byte round trip through callback_data, and what the tool is
 * finally handed.
 */
const question = (over: Partial<AskQuestion> = {}): AskQuestion => ({
  question: 'Which library?',
  header: 'Library',
  options: [option('React'), option('Vue')],
  ...over,
});

describe('renderQuestion', () => {
  it('carries the descriptions the buttons cannot', () => {
    // The buttons show labels only, so a body without descriptions makes you
    // choose between two words with no idea what either means.
    const text = renderQuestion(question(), 0, 1);
    assert.equal(
      text,
      '❓ [Library] Which library?\n\n• React — pick React\n• Vue — pick Vue\n' +
        '✏️ Other — tap it and type your own answer.',
    );
  });

  it('offers Other on every question, whatever shape it is', () => {
    // The options are Claude's guesses at what you might want. A question you
    // can only answer from its own list turns a wrong guess into your
    // instruction — the opposite of why it asked.
    for (const shape of [question(), question({ multiSelect: true }), question({ header: undefined })]) {
      assert.match(renderQuestion(shape, 0, 1), /✏️ Other/);
    }
  });

  it('numbers itself only when there is more than one question', () => {
    assert.match(renderQuestion(question(), 0, 2), /^❓ \(1\/2\)/);
    assert.doesNotMatch(renderQuestion(question(), 0, 1), /\(1\/1\)/);
  });

  it('says how to finish a multi-select, which is not otherwise discoverable', () => {
    assert.match(renderQuestion(question({ multiSelect: true }), 0, 1), /Pick any, then press Done\./);
  });

  it('omits an absent header rather than printing empty brackets', () => {
    assert.match(renderQuestion(question({ header: undefined }), 0, 1), /^❓ Which library\?/);
  });
});

describe('ask callback data', () => {
  it('round-trips an option tap', () => {
    assert.deepEqual(parseAskCallback(askCallbackData('abc123', 2, 3)), {
      id: 'abc123',
      questionIndex: 2,
      choice: 3,
    });
  });

  it('round-trips Done', () => {
    assert.deepEqual(parseAskCallback(askCallbackData('abc123', 0, 'done')), {
      id: 'abc123',
      questionIndex: 0,
      choice: 'done',
    });
  });

  it('round-trips Other', () => {
    assert.deepEqual(parseAskCallback(askCallbackData('abc123', 1, 'other')), {
      id: 'abc123',
      questionIndex: 1,
      choice: 'other',
    });
  });

  it('fits Telegram’s 64-byte callback_data cap at the worst case', () => {
    // Ids are 12 hex characters and AskUserQuestion allows at most four
    // questions of four options. Labels are deliberately not in here; one long
    // enough would push a real tap over the cap and Telegram rejects the
    // *message*, so the question would never appear at all.
    for (const choice of [3, 'done', 'other'] as const) {
      const worst = askCallbackData('a'.repeat(12), 3, choice);
      assert.ok(Buffer.byteLength(worst) <= 64, `${worst} is ${Buffer.byteLength(worst)} bytes`);
    }
  });

  it('ignores callbacks that are not ours', () => {
    // perm: shares the same callback stream and must still reach its own handler.
    assert.equal(parseAskCallback('perm:abc123:allow'), undefined);
    assert.equal(parseAskCallback('nonsense'), undefined);
  });

  it('rejects a malformed one rather than answering the wrong question', () => {
    assert.equal(parseAskCallback('ask:abc:notanumber:1'), undefined);
    assert.equal(parseAskCallback('ask:abc:0:notanumber'), undefined);
    assert.equal(parseAskCallback('ask:abc:-1:0'), undefined);
    assert.equal(parseAskCallback('ask::0:0'), undefined);
    assert.equal(parseAskCallback('ask:abc:0'), undefined);
  });
});

describe('toAnswers', () => {
  const questions = [question(), question({ question: 'Which approach?', header: 'Approach' })];

  it('keys by question text, which is what the tool looks answers up by', () => {
    // Keyed by index, the payload is silently ignored and the result is
    // indistinguishable from never having answered at all.
    const answers = toAnswers(questions, new Map([[0, ['React']]]));
    assert.deepEqual(answers, { 'Which library?': 'React' });
  });

  it('joins a multi-select into the single string the field holds', () => {
    const answers = toAnswers(questions, new Map([[0, ['React', 'Vue']]]));
    assert.deepEqual(answers, { 'Which library?': 'React, Vue' });
  });

  it('answers every question that was picked', () => {
    const answers = toAnswers(
      questions,
      new Map([
        [0, ['React']],
        [1, ['Rewrite']],
      ]),
    );
    assert.deepEqual(answers, { 'Which library?': 'React', 'Which approach?': 'Rewrite' });
  });

  it('leaves out a question with nothing picked', () => {
    assert.deepEqual(toAnswers(questions, new Map([[0, []]])), {});
  });

  it('ignores an index with no question behind it', () => {
    assert.deepEqual(toAnswers(questions, new Map([[9, ['React']]])), {});
  });
});

/**
 * The transcript tail shown when /watch or /fork opens a topic.
 *
 * The interesting case is the one a manual test caught: a real session's last
 * two entries were a tool_use and its tool_result, so the preview came out empty
 * for the busiest session on the machine.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { previewLines, renderPreview, textOfMessage } from '../src/preview.js';

const say = (role: string, text: string) => ({
  type: role,
  message: { role, content: [{ type: 'text', text }] },
});

const toolUse = () => ({
  type: 'assistant',
  message: {
    role: 'assistant',
    content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } }],
  },
});

const toolResult = () => ({
  type: 'user',
  message: {
    role: 'user',
    content: [{ type: 'tool_result', tool_use_id: 't1', content: 'a.ts\nb.ts' }],
  },
});

describe('textOfMessage', () => {
  it('reads text blocks', () => {
    assert.equal(textOfMessage(say('assistant', 'hello')), 'hello');
  });

  it('reads a plain string content', () => {
    assert.equal(textOfMessage({ message: { role: 'user', content: '  hi  ' } }), 'hi');
  });

  it('joins several text blocks', () => {
    const message = {
      message: { content: [{ type: 'text', text: 'one' }, { type: 'text', text: 'two' }] },
    };
    assert.equal(textOfMessage(message), 'one\ntwo');
  });

  it('reports tool traffic as having nothing to say', () => {
    assert.equal(textOfMessage(toolUse()), '');
    assert.equal(textOfMessage(toolResult()), '');
  });

  it('survives junk rather than throwing mid-command', () => {
    for (const junk of [undefined, null, {}, { message: {} }, { message: { content: 42 } }]) {
      assert.equal(textOfMessage(junk), '');
    }
  });
});

describe('previewLines', () => {
  it('previews a session that ends mid-tool-loop', () => {
    // The regression: filtering has to happen before slicing. Taking the last
    // two entries first yields two empty strings and no preview at all.
    const messages = [
      say('user', 'check the retry logic'),
      say('assistant', 'Let me look at the tests.'),
      toolUse(),
      toolResult(),
    ];
    assert.deepEqual(previewLines(messages), ['check the retry logic', 'Let me look at the tests.']);
  });

  it('takes the last two speaking turns, not the last two entries', () => {
    const messages = [
      say('user', 'first'),
      toolUse(),
      say('assistant', 'second'),
      toolResult(),
      say('user', 'third'),
      toolUse(),
    ];
    assert.deepEqual(previewLines(messages), ['second', 'third']);
  });

  it('truncates a long turn instead of flooding the topic', () => {
    const [line] = previewLines([say('assistant', 'x'.repeat(1000))]);
    assert.equal(line.length, 301, '300 characters plus the ellipsis');
    assert.ok(line.endsWith('…'));
  });

  it('leaves a short turn alone', () => {
    assert.deepEqual(previewLines([say('assistant', 'short')]), ['short']);
  });

  it('returns nothing for a session with no speech at all', () => {
    assert.deepEqual(previewLines([toolUse(), toolResult()]), []);
    assert.deepEqual(previewLines([]), []);
  });
});

describe('renderPreview', () => {
  it('renders the turns under a heading', () => {
    const rendered = renderPreview([say('user', 'hola'), say('assistant', 'buenas')]);
    assert.match(rendered, /Where it left off/);
    assert.match(rendered, /— hola\n— buenas/);
  });

  it('renders nothing at all when there is nothing to show', () => {
    // Not a bare heading over an empty list.
    assert.equal(renderPreview([toolUse()]), '');
  });
});

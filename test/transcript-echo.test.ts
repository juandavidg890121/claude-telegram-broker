/**
 * The echo's rendering, which is the part that can fail closed.
 *
 * Telegram parses this as HTML, so the transcript — arbitrary speech — is
 * untrusted input to a parser. Getting it wrong is not a cosmetic bug: the API
 * rejects the whole message, and the echo goes missing on exactly the voice note
 * you needed to check before Claude acted on it.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { escapeHtml, renderTranscript } from '../src/transcript-echo.js';
import { MAX_LEN } from '../src/chunk.js';

describe('escapeHtml', () => {
  it('escapes the three characters Telegram parses', () => {
    assert.equal(escapeHtml('a & b < c > d'), 'a &amp; b &lt; c &gt; d');
  });

  it('escapes the ampersand first, so escapes are not re-escaped', () => {
    // '&' -> '&amp;' then '<' -> '&lt;' is correct; the other order turns the
    // '&' of '&lt;' into '&amp;lt;' and Telegram prints the markup at you.
    assert.equal(escapeHtml('<'), '&lt;');
    assert.equal(escapeHtml('&lt;'), '&amp;lt;', 'text that already looks escaped is still text');
  });

  it('leaves ordinary speech untouched', () => {
    // The common case: escaping must not disturb accents, emoji or punctuation.
    assert.equal(escapeHtml('borra el branch viejo, ¿vale?'), 'borra el branch viejo, ¿vale?');
    assert.equal(escapeHtml("it's 100% done — ship it 🚀"), "it's 100% done — ship it 🚀");
  });
});

describe('renderTranscript', () => {
  it('labels and quotes the first page', () => {
    assert.equal(renderTranscript('deploy it'), '🎙️ Heard:\n<blockquote>deploy it</blockquote>');
  });

  it('drops the label on later pages', () => {
    // A repeated "Heard:" would read as a second transcript rather than page two.
    assert.equal(renderTranscript('…and then restart it', false), '<blockquote>…and then restart it</blockquote>');
  });

  it('neutralises dictated markup', () => {
    // Say "wrap it in a <div> tag" out loud and the raw text is a tag Telegram
    // cannot parse — a 400 that takes the whole echo down with it.
    assert.equal(
      renderTranscript('wrap it in a <div> tag'),
      '🎙️ Heard:\n<blockquote>wrap it in a &lt;div&gt; tag</blockquote>',
    );
  });

  it('cannot be talked into closing its own quote', () => {
    // The transcript is untrusted input to a parser. If it could close the
    // blockquote it could open anything else.
    const rendered = renderTranscript('</blockquote><b>not bold</b>');
    assert.equal(rendered.match(/<blockquote>/g)?.length, 1);
    assert.equal(rendered.match(/<\/blockquote>/g)?.length, 1);
    assert.ok(rendered.endsWith('</blockquote>'));
    assert.ok(!rendered.includes('<b>'), 'the tag must arrive as text, not markup');
  });

  it('keeps a full-length page inside Telegram limits once escaped', () => {
    // chunkify measures raw text, escaping only grows it, and the wrapper adds
    // its own overhead — so the worst realistic page is a full chunk of speech.
    const page = 'a'.repeat(MAX_LEN);
    assert.ok(renderTranscript(page).length <= 4096, 'a full page must still be sendable');
  });
});

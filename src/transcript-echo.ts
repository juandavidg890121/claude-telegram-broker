/**
 * How a voice note's transcript is shown before Claude acts on it.
 *
 * The echo exists because whisper guesses, and the window to catch a misheard
 * instruction with /interrupt closes the moment Claude starts. But an echo you
 * mistake for Claude's own words is barely an echo: everything in a topic
 * arrives from the same bot, in the same lane, as plain text — your words wore
 * the same clothes as its replies, with a 🎙️ as the only tell.
 *
 * So the transcript is quoted rather than spoken: a blockquote reads as
 * something being reported, not said. The caller anchors it to the voice note
 * itself, which is what disambiguates two notes sent back to back.
 */

/**
 * Escape for Telegram's HTML parse mode, which needs exactly these three.
 *
 * Not cosmetic. The transcript is whatever you said out loud, and dictating
 * "wrap it in a <div>" would otherwise reach Telegram as a tag it cannot parse:
 * the API rejects the whole message with a 400, and the echo never appears —
 * on precisely the message you needed to check. Ampersand goes first, or it
 * would re-escape the escapes.
 */
export function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * One page of the echo. `first` carries the label; later pages are bare quotes,
 * since a long transcript repeating "Heard:" reads as several transcripts.
 *
 * Chunk the *raw* text before calling this, never the escaped output: a cut
 * landing inside `&amp;` produces half an entity, which is the same 400 the
 * escaping was there to prevent.
 */
export function renderTranscript(chunk: string, first = true): string {
  const label = first ? '🎙️ Heard:\n' : '';
  return `${label}<blockquote>${escapeHtml(chunk)}</blockquote>`;
}

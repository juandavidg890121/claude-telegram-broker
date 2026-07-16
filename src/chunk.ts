/** Telegram caps a message at 4096 characters. */
export const MAX_LEN = 4000;

/**
 * Split text into Telegram-sized messages.
 *
 * Lives on its own rather than inside telegram.ts because the Stop hook needs it
 * too, and importing it from there would drag in config.ts — whose module-level
 * validation throws unless the *broker's* env is present. A hook is not the
 * broker; it should not have to satisfy the broker's startup contract to reuse
 * four lines of string splitting.
 */
export function chunkify(text: string): string[] {
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > MAX_LEN) {
    // Prefer a paragraph or line boundary so code blocks stay readable.
    const cut = rest.lastIndexOf('\n', MAX_LEN);
    const at = cut > MAX_LEN / 2 ? cut : MAX_LEN;
    chunks.push(rest.slice(0, at));
    rest = rest.slice(at);
  }
  if (rest.trim()) chunks.push(rest);
  return chunks;
}

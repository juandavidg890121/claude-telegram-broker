/**
 * Rendering the tail of a transcript for a human opening a topic on their phone.
 *
 * Pure on purpose: this logic shipped inside index.ts, where the module's
 * startup side effects make it untestable, and promptly got it wrong on the
 * busiest session on the machine.
 */
const MAX_PREVIEW_CHARS = 300;

/** The text a transcript entry shows a human, or '' for tool traffic. */
export function textOfMessage(message: unknown): string {
  const content = (message as { message?: { content?: unknown } })?.message?.content;
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return '';
  return content
    .filter((block): block is { type: 'text'; text: string } => block?.type === 'text')
    .map((block) => block.text)
    .join('\n')
    .trim();
}

/**
 * The last `count` entries that actually say something.
 *
 * Filtering precedes slicing, and that order is the whole point: a session
 * usually stops mid-tool-loop, so its final entries are routinely a tool_use and
 * its tool_result — no text blocks anywhere. Slicing first and extracting second
 * silently yields nothing exactly when the session is most worth previewing.
 */
export function previewLines(messages: readonly unknown[], count = 2): string[] {
  return messages
    .map(textOfMessage)
    .filter((text) => text.length > 0)
    .slice(-count)
    .map((text) => (text.length > MAX_PREVIEW_CHARS ? `${text.slice(0, MAX_PREVIEW_CHARS)}…` : text));
}

export function renderPreview(messages: readonly unknown[]): string {
  const lines = previewLines(messages);
  return lines.length ? `\n\n*Where it left off:*\n${lines.map((l) => `— ${l}`).join('\n')}` : '';
}

import { chunkify } from './chunk.js';

/**
 * What a hook needs to speak to Telegram, and nothing more.
 *
 * Its own module for the reason chunk.ts is: a hook is not the broker. Going
 * through telegram.ts would drag in config.ts, whose module-level validation
 * throws unless the *broker's* env is present — a Stop hook firing inside your
 * VS Code session should not have to satisfy the broker's startup contract to
 * send one message.
 *
 * So each hook grew its own copy of these three instead, byte for byte. Two
 * copies is a coincidence; the third is a pattern, and the pattern is that the
 * next fix to `send` lands in one of them and not the others.
 */

/** Read a hook's JSON payload from stdin. */
export async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * Split a conversation id into where a message goes.
 *
 * Thread 0 means "no topic": the broker writes `<chat>:0` for a plain chat, and
 * passing message_thread_id=0 to Telegram is an error rather than a no-op.
 */
export function target(conversationId: string): { chatId: string; threadId?: number } {
  const [chatId, thread] = conversationId.split(':');
  const threadId = Number(thread);
  return { chatId, threadId: threadId > 0 ? threadId : undefined };
}

/** Raw sendMessage. Throws on a non-2xx so the caller can decide what that means. */
export async function send(
  token: string,
  chatId: string,
  threadId: number | undefined,
  text: string,
): Promise<void> {
  const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, message_thread_id: threadId }),
  });
  if (!response.ok) throw new Error(`sendMessage ${response.status}: ${await response.text()}`);
}

/**
 * Send `text` to a conversation, split to fit, never throwing.
 *
 * Best-effort by design: a hook runs inside a real session, and a Telegram
 * hiccup must not fail the turn it is reporting on. Failures go to stderr,
 * where they show up in the hook's output rather than vanishing.
 */
export async function notify(conversationId: string, token: string, text: string, tag: string): Promise<void> {
  const { chatId, threadId } = target(conversationId);
  for (const chunk of chunkify(text)) {
    try {
      await send(token, chatId, threadId, chunk);
    } catch (error) {
      console.error(`[${tag}] ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

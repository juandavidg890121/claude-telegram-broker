/**
 * Which typed message is an answer to a question, and which is just a message.
 *
 * Its own module, and tested, because the failure it guards against is the worst
 * one this feature can produce: swallowing something you meant for Claude. A
 * message eaten here does not bounce or warn — it lands as the answer to a
 * multiple-choice question and steers the turn. So the rules are narrow and
 * explicit rather than "capture the next thing that arrives".
 *
 * Armed only by tapping Other, one message only, and forgotten the moment the
 * question it belongs to is settled by any other route.
 */

export type Awaiting = { askId: string; questionIndex: number };

/** Commands are never answers, so /stop and /interrupt still work while armed. */
export function isTypedAnswer(text: string): boolean {
  return text.trim().length > 0 && !text.trimStart().startsWith('/');
}

export class FreeTextCapture {
  /** conversation -> the question it owes a typed answer to. */
  private readonly armed = new Map<string, Awaiting>();

  /**
   * Wait for a typed answer in this conversation.
   *
   * One per conversation by construction — a topic is one session, and a second
   * Other tap means you changed your mind about which question to type into, not
   * that you want to answer two at once with one message.
   */
  arm(conversationId: string, awaiting: Awaiting): void {
    this.armed.set(conversationId, awaiting);
  }

  /** What this conversation is waiting on, without consuming it. */
  peek(conversationId: string): Awaiting | undefined {
    return this.armed.get(conversationId);
  }

  /**
   * Take the typed answer, if this message is one.
   *
   * Consuming disarms: a second message after answering belongs to the session,
   * not to a question that is already answered.
   */
  consume(conversationId: string, text: string): Awaiting | undefined {
    const awaiting = this.armed.get(conversationId);
    if (!awaiting || !isTypedAnswer(text)) return undefined;
    this.armed.delete(conversationId);
    return awaiting;
  }

  /** Forget everything armed for an ask — it was settled some other way. */
  clearAsk(askId: string): void {
    for (const [conversationId, awaiting] of this.armed) {
      if (awaiting.askId === askId) this.armed.delete(conversationId);
    }
  }
}

/**
 * The seam that keeps Telegram swappable. The broker and the session manager
 * only ever talk to this interface, so a Discord/web/CLI frontend is a new
 * implementation of `Frontend` and nothing else changes.
 *
 * A "conversation" is whatever the frontend uses to keep threads apart — for
 * Telegram it's a forum topic; each conversation maps to exactly one session.
 */

import type { AskAnswers, AskQuestion } from './asks.js';

export type Inbound = {
  conversationId: string;
  userId: string;
  text: string;
};

export type PermissionAsk = {
  toolName: string;
  /** Short human-readable summary of what the tool wants to do. */
  preview: string;
};

export type CommandHandler = (msg: Inbound, args: string) => Promise<void>;

/**
 * An AskUserQuestion put to the human, with the buttons to answer it.
 *
 * Deliberately not folded into `askPermission`. A permission is a yes/no about
 * something Claude wants to *do*, and the answer is a verdict; this is a choice
 * between options, and the answer is *content* — it becomes the tool's result
 * and the conversation continues with it. Sharing one method would mean one of
 * the two lying about what its return value means.
 *
 * `id` comes from the caller rather than being minted here: on the /watch path
 * it is the id the hook is waiting on, and the frontend has no way to invent it.
 */
export type QuestionAsk = {
  id: string;
  questions: AskQuestion[];
  /** Line shown above the questions, e.g. which session is asking. */
  note?: string;
  /** Epoch ms after which the answer is no longer wanted. */
  expiresAt: number;
};

export interface Frontend {
  readonly name: string;

  /** Begin receiving messages. Resolves once the frontend is connected. */
  start(): Promise<void>;
  stop(): Promise<void>;

  onMessage(handler: (msg: Inbound) => Promise<void>): void;
  onCommand(command: string, handler: CommandHandler): void;

  sendText(conversationId: string, text: string): Promise<void>;

  /** Blocks until the human answers. `true` allows the tool call. */
  askPermission(conversationId: string, ask: PermissionAsk): Promise<boolean>;

  /**
   * Blocks until every question is answered, or `expiresAt` passes.
   *
   * Resolves `undefined` on expiry rather than throwing or guessing an answer:
   * both callers have a real fallback for "nobody answered" — the owned session
   * tells Claude to proceed without it, the hook lets the question fall through
   * to the terminal — and neither is served by a made-up choice.
   */
  askQuestions(conversationId: string, ask: QuestionAsk): Promise<AskAnswers | undefined>;

  /**
   * Open a new conversation and return its id. Frontends without a native
   * thread concept may return the id of the conversation they were asked from.
   */
  createConversation(title: string, from: Inbound): Promise<string>;
}

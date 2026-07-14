/**
 * The seam that keeps Telegram swappable. The broker and the session manager
 * only ever talk to this interface, so a Discord/web/CLI frontend is a new
 * implementation of `Frontend` and nothing else changes.
 *
 * A "conversation" is whatever the frontend uses to keep threads apart — for
 * Telegram it's a forum topic; each conversation maps to exactly one session.
 */

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
   * Open a new conversation and return its id. Frontends without a native
   * thread concept may return the id of the conversation they were asked from.
   */
  createConversation(title: string, from: Inbound): Promise<string>;
}

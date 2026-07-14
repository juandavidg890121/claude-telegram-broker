import { Bot, InlineKeyboard, type Context, type Filter } from 'grammy';
import { randomBytes } from 'node:crypto';
import type { CommandHandler, Frontend, Inbound, PermissionAsk } from './frontend.js';
import { config } from './config.js';

/** Telegram caps a message at 4096 characters. */
const MAX_LEN = 4000;

type Pending = { resolve: (allowed: boolean) => void };

/**
 * The single owner of the bot token. Telegram's getUpdates allows exactly one
 * poller per token, which is precisely why the broker exists as one long-lived
 * process rather than one poller per Claude session.
 */
export class TelegramFrontend implements Frontend {
  readonly name = 'telegram';

  private readonly bot: Bot;
  private readonly pending = new Map<string, Pending>();
  private messageHandler?: (msg: Inbound) => Promise<void>;
  private readonly commands = new Map<string, CommandHandler>();

  constructor() {
    this.bot = new Bot(config.telegram.token);
    this.bot.on('message:text', (ctx) => this.handleText(ctx));
    this.bot.on('callback_query:data', (ctx) => this.handleCallback(ctx));
  }

  async start(): Promise<void> {
    // grammY's run/start only resolves on stop, so kick it off in the background.
    void this.bot.start({
      onStart: (info) => console.log(`[telegram] polling as @${info.username}`),
    });
  }

  async stop(): Promise<void> {
    await this.bot.stop();
  }

  onMessage(handler: (msg: Inbound) => Promise<void>): void {
    this.messageHandler = handler;
  }

  onCommand(command: string, handler: CommandHandler): void {
    this.commands.set(command, handler);
  }

  async sendText(conversationId: string, text: string): Promise<void> {
    const { chatId, threadId } = split(conversationId);
    for (const chunk of chunkify(text)) {
      await this.bot.api.sendMessage(chatId, chunk, {
        message_thread_id: threadId,
      });
    }
  }

  async askPermission(conversationId: string, ask: PermissionAsk): Promise<boolean> {
    const id = randomBytes(6).toString('hex');
    const { chatId, threadId } = split(conversationId);

    const keyboard = new InlineKeyboard()
      .text('✅ Allow', `perm:${id}:allow`)
      .text('⛔ Deny', `perm:${id}:deny`);

    await this.bot.api.sendMessage(
      chatId,
      `🔐 Claude wants to run *${ask.toolName}*\n\n\`${ask.preview}\``,
      { message_thread_id: threadId, parse_mode: 'Markdown', reply_markup: keyboard },
    );

    return new Promise<boolean>((resolve) => {
      this.pending.set(id, { resolve });
    });
  }

  async createConversation(title: string, from: Inbound): Promise<string> {
    const groupId = config.telegram.groupId;
    if (!groupId) {
      // No forum group configured: one session per chat, in place.
      return from.conversationId;
    }
    const topic = await this.bot.api.createForumTopic(groupId, title);
    return `${groupId}:${topic.message_thread_id}`;
  }

  private async handleText(ctx: Filter<Context, 'message:text'>): Promise<void> {
    const userId = String(ctx.from?.id ?? '');
    // Gate on the sender, never the chat: in a group, the chat id says nothing
    // about who is actually typing.
    if (!config.telegram.allowedUsers.has(userId)) return;

    const text = ctx.message.text;
    const msg: Inbound = {
      conversationId: `${ctx.chat.id}:${ctx.message.message_thread_id ?? 0}`,
      userId,
      text,
    };

    if (text.startsWith('/')) {
      const [word, ...rest] = text.slice(1).split(/\s+/);
      const handler = this.commands.get(word.split('@')[0]);
      if (handler) {
        await handler(msg, rest.join(' '));
        return;
      }
    }

    await this.messageHandler?.(msg);
  }

  private async handleCallback(ctx: Filter<Context, 'callback_query:data'>): Promise<void> {
    const userId = String(ctx.from.id);
    const [kind, id, verdict] = ctx.callbackQuery.data.split(':');
    if (kind !== 'perm') return;

    // Anyone who can answer a permission prompt can approve tool use on this
    // machine — so the allowlist gates the buttons too.
    if (!config.telegram.allowedUsers.has(userId)) {
      await ctx.answerCallbackQuery({ text: 'Not allowed.' });
      return;
    }

    const waiter = this.pending.get(id);
    if (!waiter) {
      await ctx.answerCallbackQuery({ text: 'This request already expired.' });
      return;
    }

    this.pending.delete(id);
    waiter.resolve(verdict === 'allow');
    await ctx.answerCallbackQuery({ text: verdict === 'allow' ? 'Allowed' : 'Denied' });
    await ctx.editMessageReplyMarkup({ reply_markup: undefined });
  }
}

function split(conversationId: string): { chatId: number; threadId?: number } {
  const [chat, thread] = conversationId.split(':');
  const threadId = Number(thread);
  return { chatId: Number(chat), threadId: threadId > 0 ? threadId : undefined };
}

function chunkify(text: string): string[] {
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

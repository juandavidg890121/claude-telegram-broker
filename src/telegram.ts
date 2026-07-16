import { Bot, InlineKeyboard, type Context, type Filter } from 'grammy';
import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { CommandHandler, Frontend, Inbound, PermissionAsk } from './frontend.js';
import { config } from './config.js';

const PHOTOS_DIR = join(homedir(), '.claude', 'telegram_mirror', 'photos');
const AUDIO_DIR = join(homedir(), '.claude', 'telegram_mirror', 'audio');

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
    this.bot.on('message:photo', (ctx) => this.handlePhoto(ctx));
    this.bot.on(['message:voice', 'message:audio'], (ctx) => this.handleVoice(ctx));
    this.bot.on('callback_query:data', (ctx) => this.handleCallback(ctx));
    // Without this, any failed API call takes the whole broker down and every
    // live session with it.
    this.bot.catch((err) => console.error(`[telegram] ${err.message}`));
  }

  async start(): Promise<void> {
    // grammY's run/start only resolves on stop, so kick it off in the background.
    void this.bot.start({
      onStart: async (info) => {
        console.log(`[telegram] polling as @${info.username}`);
        // With privacy mode on (the BotFather default) Telegram never delivers
        // ordinary group messages to the bot, so a topic looks dead with no
        // error anywhere. Say so at startup rather than let it be debugged.
        if (config.telegram.groupId && !info.can_read_all_group_messages) {
          console.warn(
            '[telegram] privacy mode is ON: this bot will NOT receive normal messages\n' +
              '           in groups, only commands. Fix it in @BotFather:\n' +
              '           /setprivacy -> pick this bot -> Disable, then REMOVE and RE-ADD\n' +
              '           the bot to the group (the change only applies on re-join).',
          );
        }
        await this.checkGroup(info.id);
      },
    });
  }

  /**
   * Everything that has to be true before /new can open a topic, checked once at
   * startup. Each of these otherwise surfaces as an opaque 400 halfway through a
   * command.
   */
  private async checkGroup(botId: number): Promise<void> {
    const groupId = config.telegram.groupId;
    if (!groupId) {
      console.warn('[telegram] TELEGRAM_GROUP_ID is unset: /new cannot create topics.');
      return;
    }

    try {
      const chat = await this.bot.api.getChat(groupId);
      if (!('is_forum' in chat) || !chat.is_forum) {
        console.warn(
          `[telegram] "${groupId}" is not a forum. Enable Topics in the group settings,` +
            ' or /new has nowhere to put a session.',
        );
      }

      const me = await this.bot.api.getChatMember(groupId, botId);
      const canManageTopics = me.status === 'creator' || (me.status === 'administrator' && me.can_manage_topics);
      if (!canManageTopics) {
        console.warn(
          `[telegram] the bot is "${me.status}" in this group, without Manage Topics.\n` +
            '           Promote it to admin with that permission, or /new will fail.',
        );
      } else {
        console.log('[telegram] group OK: forum + Manage Topics.');
      }
    } catch (error) {
      console.error(
        `[telegram] cannot reach group ${groupId}: ${error instanceof Error ? error.message : error}\n` +
          '           Supergroup ids are negative (-100…). Check the bot is a member.',
      );
    }
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
    const where = `chat=${ctx.chat.id} topic=${ctx.message.message_thread_id ?? 0}`;

    // Gate on the sender, never the chat: in a group, the chat id says nothing
    // about who is actually typing. Log the drop — a silent one is impossible to
    // tell apart from Telegram never delivering the message at all.
    if (!config.telegram.allowedUsers.has(userId)) {
      console.warn(`[telegram] dropped: user ${userId} not in TELEGRAM_ALLOWED_USERS (${where})`);
      return;
    }
    console.log(`[telegram] from ${userId} ${where}`);

    const text = ctx.message.text;
    const msg: Inbound = {
      conversationId: `${ctx.chat.id}:${ctx.message.message_thread_id ?? 0}`,
      userId,
      text,
    };

    // A throwing handler must not take the broker down with it — report it in
    // the chat where the human can act on it.
    try {
      if (text.startsWith('/')) {
        const [word, ...rest] = text.slice(1).split(/\s+/);
        const handler = this.commands.get(word.split('@')[0]);
        if (handler) {
          await handler(msg, rest.join(' '));
          return;
        }
      }
      await this.messageHandler?.(msg);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      console.error(`[telegram] handler failed: ${reason}`);
      await this.sendText(msg.conversationId, `⚠️ ${reason}`).catch(() => {});
    }
  }

  /**
   * Telegram delivers photos as `message:photo`, never `message:text` -- a
   * plain `bot.on('message:text', ...)` handler silently never fires for them,
   * which is why photos looked like they vanished rather than erroring.
   *
   * No multimodal wiring here: the photo is downloaded to disk and the human
   * (or the mirrored session, via the same relay path as text) gets a plain
   * text message pointing at the file. Claude's own Read tool already handles
   * images, so this is the smallest thing that actually works end to end,
   * for both broker-owned sessions and mirrored ones.
   */
  private async handlePhoto(ctx: Filter<Context, 'message:photo'>): Promise<void> {
    const userId = String(ctx.from?.id ?? '');
    const where = `chat=${ctx.chat.id} topic=${ctx.message.message_thread_id ?? 0}`;

    if (!config.telegram.allowedUsers.has(userId)) {
      console.warn(`[telegram] dropped photo: user ${userId} not in TELEGRAM_ALLOWED_USERS (${where})`);
      return;
    }

    const msg: Inbound = {
      conversationId: `${ctx.chat.id}:${ctx.message.message_thread_id ?? 0}`,
      userId,
      text: '',
    };

    try {
      // Largest size is last in the array.
      const sizes = ctx.message.photo;
      const fileId = sizes[sizes.length - 1].file_id;
      const file = await ctx.api.getFile(fileId);
      const url = `https://api.telegram.org/file/bot${config.telegram.token}/${file.file_path}`;
      const res = await fetch(url);
      if (!res.ok) throw new Error(`download failed: ${res.status}`);
      const bytes = Buffer.from(await res.arrayBuffer());

      mkdirSync(PHOTOS_DIR, { recursive: true });
      const ext = file.file_path?.split('.').pop() ?? 'jpg';
      const localPath = join(PHOTOS_DIR, `${Date.now()}-${randomBytes(4).toString('hex')}.${ext}`);
      writeFileSync(localPath, bytes);

      const caption = ctx.message.caption?.trim();
      console.log(`[telegram] photo from ${userId} ${where} -> ${localPath}`);

      msg.text =
        `[Telegram photo saved to ${localPath} -- use the Read tool to view it]` +
        (caption ? `\n${caption}` : '');
      await this.messageHandler?.(msg);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      console.error(`[telegram] photo handler failed: ${reason}`);
      await this.sendText(msg.conversationId, `⚠️ Couldn't process that photo: ${reason}`).catch(() => {});
    }
  }

  /**
   * Voice notes (`message.voice`, OGG/Opus) and audio files (`message.audio`)
   * both land here. Downloaded to disk the same way photos are, then
   * transcribed via Groq's Whisper endpoint if GROQ_API_KEY is set -- Claude's
   * Read tool has no audio path the way it does for images, so without a
   * transcript the file would be saved but effectively invisible to Claude.
   * Missing key or a failed transcription still delivers the file path, just
   * without text -- never drops the message outright.
   */
  private async handleVoice(ctx: Filter<Context, 'message:voice' | 'message:audio'>): Promise<void> {
    const userId = String(ctx.from?.id ?? '');
    const where = `chat=${ctx.chat.id} topic=${ctx.message.message_thread_id ?? 0}`;

    if (!config.telegram.allowedUsers.has(userId)) {
      console.warn(`[telegram] dropped audio: user ${userId} not in TELEGRAM_ALLOWED_USERS (${where})`);
      return;
    }

    const msg: Inbound = {
      conversationId: `${ctx.chat.id}:${ctx.message.message_thread_id ?? 0}`,
      userId,
      text: '',
    };

    try {
      const media = ctx.message.voice ?? ctx.message.audio;
      if (!media) throw new Error('no voice/audio payload on message');
      const file = await ctx.api.getFile(media.file_id);
      const url = `https://api.telegram.org/file/bot${config.telegram.token}/${file.file_path}`;
      const res = await fetch(url);
      if (!res.ok) throw new Error(`download failed: ${res.status}`);
      const bytes = Buffer.from(await res.arrayBuffer());

      mkdirSync(AUDIO_DIR, { recursive: true });
      const ext = file.file_path?.split('.').pop() ?? 'oga';
      const localPath = join(AUDIO_DIR, `${Date.now()}-${randomBytes(4).toString('hex')}.${ext}`);
      writeFileSync(localPath, bytes);
      console.log(`[telegram] audio from ${userId} ${where} -> ${localPath}`);

      const caption = 'caption' in ctx.message ? ctx.message.caption?.trim() : undefined;
      const transcript = await this.transcribeAudio(localPath).catch((error) => {
        console.error(`[telegram] transcription failed: ${error instanceof Error ? error.message : error}`);
        return null;
      });

      msg.text = transcript
        ? `[Telegram voice message, transcribed]\n${transcript}`
        : `[Telegram voice message saved to ${localPath} -- no transcript available]`;
      if (caption) msg.text += `\n${caption}`;
      await this.messageHandler?.(msg);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      console.error(`[telegram] audio handler failed: ${reason}`);
      await this.sendText(msg.conversationId, `⚠️ Couldn't process that voice message: ${reason}`).catch(() => {});
    }
  }

  private async transcribeAudio(localPath: string): Promise<string | null> {
    if (!config.groqApiKey) return null;
    const form = new FormData();
    form.append('file', new Blob([readFileSync(localPath)]), 'audio.oga');
    form.append('model', 'whisper-large-v3-turbo');
    const res = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${config.groqApiKey}` },
      body: form,
    });
    if (!res.ok) throw new Error(`Groq transcription failed: ${res.status} ${await res.text()}`);
    const data = (await res.json()) as { text?: string };
    return data.text?.trim() || null;
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

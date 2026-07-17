import { Bot, InlineKeyboard, type Context, type Filter } from 'grammy';
import { randomBytes } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { CommandHandler, Frontend, Inbound, PermissionAsk } from './frontend.js';
import { config } from './config.js';
import { chunkify } from './chunk.js';
import { audioStatus, transcribe } from './audio.js';

/** Photos land here for Claude's Read tool to pick up. Not under the /watch
 *  mirror directory: those are keyed by session id and cleaned per session,
 *  while a photo belongs to whichever conversation received it. */
const PHOTOS_DIR = join(homedir(), '.claude', 'telegram_photos');

/** Voice notes, deleted as soon as they are transcribed — the text is the
 *  artefact, and a recording of your voice is not something to leave lying
 *  around. */
const AUDIO_DIR = join(homedir(), '.claude', 'telegram_audio');

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
    this.bot.on(['message:voice', 'message:audio'], (ctx) => this.handleAudio(ctx));
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
   * Telegram delivers photos as `message:photo`, never `message:text`, so a
   * text-only handler silently never fires for them — they look like they
   * vanish rather than erroring.
   *
   * No multimodal wiring: the photo is saved and the session gets a text message
   * pointing at the file, because Claude's own Read tool already handles images.
   * That keeps this working identically for owned sessions and for /watch, where
   * the relay carries text and nothing else.
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
      // Telegram orders sizes smallest-first; the last one is the original.
      const sizes = ctx.message.photo;
      const file = await ctx.api.getFile(sizes[sizes.length - 1].file_id);
      const response = await fetch(
        `https://api.telegram.org/file/bot${config.telegram.token}/${file.file_path}`,
      );
      if (!response.ok) throw new Error(`download failed: ${response.status}`);

      mkdirSync(PHOTOS_DIR, { recursive: true });
      const ext = file.file_path?.split('.').pop() ?? 'jpg';
      const localPath = join(PHOTOS_DIR, `${Date.now()}-${randomBytes(4).toString('hex')}.${ext}`);
      writeFileSync(localPath, Buffer.from(await response.arrayBuffer()));
      console.log(`[telegram] photo from ${userId} ${where} -> ${localPath}`);

      const caption = ctx.message.caption?.trim();
      msg.text =
        `[Telegram photo saved to ${localPath} — use the Read tool to view it]` +
        (caption ? `\n${caption}` : '');
      await this.messageHandler?.(msg);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      console.error(`[telegram] photo handler failed: ${reason}`);
      await this.sendText(msg.conversationId, `⚠️ Couldn't process that photo: ${reason}`).catch(() => {});
    }
  }

  /**
   * Voice notes and audio files.
   *
   * Claude has no audio input — the Messages API takes text, images and PDFs,
   * and the model exposes an `image_input` capability with no audio equivalent —
   * so a voice note is only useful once something turns it into text. That
   * something is an optional local whisper.cpp (see audio.ts for why local).
   *
   * Every branch answers. Telegram delivers these as `message:voice` /
   * `message:audio`, which no text handler matches, so the alternative to a
   * reply is total silence — indistinguishable from a broken bot.
   */
  private async handleAudio(ctx: Context): Promise<void> {
    const userId = String(ctx.from?.id ?? '');
    if (!config.telegram.allowedUsers.has(userId)) {
      console.warn(`[telegram] dropped audio: user ${userId} not in TELEGRAM_ALLOWED_USERS`);
      return;
    }

    const conversationId = `${ctx.chat?.id}:${ctx.message?.message_thread_id ?? 0}`;
    const status = audioStatus(config.audio.dir, config.audio.model);

    if (status.state === 'disabled') {
      await this.sendText(
        conversationId,
        `🔇 Audio is off. Claude can't hear a voice note — the API takes text, images ` +
          `and PDFs only — so transcribing it first is opt-in: point BROKER_WHISPER_DIR ` +
          `at a local whisper.cpp. See the README. Until then, type it or send a screenshot.`,
      ).catch(() => {});
      return;
    }

    if (status.state === 'incomplete') {
      await this.sendText(
        conversationId,
        `🔇 Audio is on but not usable — missing from \`${status.dir}\`:\n` +
          status.missing.map((m) => `• ${m}`).join('\n') +
          `\n\nSee the README for where to get them.`,
      ).catch(() => {});
      return;
    }

    const msg: Inbound = { conversationId, userId, text: '' };
    try {
      const file = await ctx.api.getFile(
        (ctx.message?.voice ?? ctx.message?.audio)!.file_id,
      );
      const response = await fetch(
        `https://api.telegram.org/file/bot${config.telegram.token}/${file.file_path}`,
      );
      if (!response.ok) throw new Error(`download failed: ${response.status}`);

      mkdirSync(AUDIO_DIR, { recursive: true });
      const localPath = join(AUDIO_DIR, `${Date.now()}-${randomBytes(4).toString('hex')}.ogg`);
      writeFileSync(localPath, Buffer.from(await response.arrayBuffer()));

      const text = await transcribe(localPath, status.tools, config.audio.language);
      rmSync(localPath, { force: true });

      if (!text) {
        await this.sendText(conversationId, '🔇 That came out empty — nothing recognisable in it.');
        return;
      }

      console.log(`[telegram] audio from ${userId} -> "${text.slice(0, 60)}"`);
      // No echo-back: send straight through, exactly like a typed message —
      // a voice note shouldn't cost two round trips (the transcript, then the
      // reply) when a typed message only costs one.
      msg.text = text;
      await this.messageHandler?.(msg);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      console.error(`[telegram] audio handler failed: ${reason}`);
      await this.sendText(conversationId, `⚠️ Couldn't transcribe that: ${reason}`).catch(() => {});
    }
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


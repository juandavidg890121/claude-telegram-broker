import { Bot, InlineKeyboard, type Context, type Filter } from 'grammy';
import { randomBytes } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CommandHandler, Frontend, Inbound, PermissionAsk, QuestionAsk } from './frontend.js';
import type { AskAnswers, AskQuestion } from './asks.js';
import { CLAUDE_HOME } from './claude-home.js';
import { config } from './config.js';
import { chunkify } from './chunk.js';
import { audioStatus, transcribe } from './audio.js';
import { renderTranscript } from './transcript-echo.js';
import { type AskCallback, askCallbackData, parseAskCallback, renderQuestion, toAnswers } from './ask-user-question.js';
import { FreeTextCapture } from './ask-capture.js';

/**
 * Photos land here for Claude's Read tool to pick up.
 *
 * A sibling of the /watch mirror rather than something under BROKER_MIRROR_DIR,
 * which is tempting because both are broker-owned state. That variable is not a
 * data directory: it names the handoff channel the broker and the poller inside
 * the watched session must agree on, which is why the README says to change it
 * for both or neither. Photos need no such agreement — only this process writes
 * them, and Claude is handed the absolute path. Hanging them off that variable
 * would only mean a misconfigured /watch also loses your photos.
 */
const PHOTOS_DIR = join(CLAUDE_HOME, 'telegram_photos');

/** Voice notes, deleted as soon as they are transcribed — the text is the
 *  artefact, and a recording of your voice is not something to leave lying
 *  around. Barely a directory: nothing here outlives the transcription. */
const AUDIO_DIR = join(CLAUDE_HOME, 'telegram_audio');

type Pending = { resolve: (allowed: boolean) => void };

/**
 * One AskUserQuestion in flight: which options are ticked so far, and where each
 * question's message lives so it can be edited as you answer it.
 *
 * `picked` is keyed by question index rather than text — the text is long, and
 * the callback data that arrives from a tap only carries indices anyway.
 */
type PendingAsk = {
  questions: AskQuestion[];
  picked: Map<number, string[]>;
  /** question index -> Telegram message id, for editing it in place. */
  messages: Map<number, number>;
  conversationId: string;
  chatId: number;
  threadId?: number;
  settle: (answers: AskAnswers | undefined) => void;
  timer: ReturnType<typeof setTimeout>;
};

/** Button captions stay short; the full label is in the message body above. */
const BUTTON_MAX = 32;
const buttonLabel = (label: string): string =>
  label.length > BUTTON_MAX ? `${label.slice(0, BUTTON_MAX - 1)}…` : label;

/**
 * The single owner of the bot token. Telegram's getUpdates allows exactly one
 * poller per token, which is precisely why the broker exists as one long-lived
 * process rather than one poller per Claude session.
 */
export class TelegramFrontend implements Frontend {
  readonly name = 'telegram';

  private readonly bot: Bot;
  private readonly pending = new Map<string, Pending>();
  private readonly pendingAsks = new Map<string, PendingAsk>();
  private readonly capture = new FreeTextCapture();
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

  /**
   * Show what was heard, quoted and anchored to the voice note it came from.
   *
   * Falls back to plain text if the formatted send is rejected: the transcript
   * being *visible* is the safety property, and looking good is not. Only when
   * even that fails does this throw — the caller reads that as "never shown",
   * and refuses to act on it.
   */
  private async echoTranscript(conversationId: string, text: string, replyTo?: number): Promise<void> {
    const { chatId, threadId } = split(conversationId);
    try {
      // Chunk the raw text, then render: chunkify cutting the *escaped* string
      // could split an `&amp;` down the middle and produce the very 400 the
      // escaping exists to avoid.
      const chunks = chunkify(text);
      for (const [index, chunk] of chunks.entries()) {
        await this.bot.api.sendMessage(chatId, renderTranscript(chunk, index === 0), {
          message_thread_id: threadId,
          parse_mode: 'HTML',
          // Only the first page quotes the voice note. Telegram would stack the
          // same audio bubble above every page otherwise, which reads as several
          // notes rather than one long one.
          ...(index === 0 && replyTo !== undefined
            ? { reply_parameters: { message_id: replyTo, allow_sending_without_reply: true } }
            : {}),
        });
      }
    } catch (error) {
      console.error(`[telegram] formatted echo failed, falling back to plain: ${String(error)}`);
      await this.sendText(conversationId, `🎙️ ${text}`);
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

  /**
   * Put an AskUserQuestion on the phone and wait for every question to be
   * answered.
   *
   * One message per question, each with its own keyboard, rather than one
   * message for all of them: a keyboard belongs to a message, so four questions
   * in one message would need sixteen buttons in a single grid with no way to
   * tell which row answers what.
   */
  async askQuestions(conversationId: string, ask: QuestionAsk): Promise<AskAnswers | undefined> {
    const { chatId, threadId } = split(conversationId);
    const questions = ask.questions.filter((question) => question.options?.length > 0);

    // A question with no options cannot be answered with buttons, and answering
    // *some* of a multi-question ask would hand the tool a partial payload it
    // has no way to flag. Refusing the whole thing sends it back to the terminal
    // intact, which is the only place it can still be answered properly.
    if (questions.length === 0 || questions.length !== ask.questions.length) return undefined;

    if (ask.note) await this.sendText(conversationId, ask.note).catch(() => {});

    const answered = new Promise<AskAnswers | undefined>((resolve) => {
      const timer = setTimeout(
        () => void this.expireAsk(ask.id),
        Math.max(0, ask.expiresAt - Date.now()),
      );
      // unref so a pending question never keeps the process alive through a
      // shutdown that has already closed everything else.
      timer.unref?.();
      this.pendingAsks.set(ask.id, {
        questions,
        picked: new Map(),
        messages: new Map(),
        conversationId,
        chatId,
        threadId,
        settle: resolve,
        timer,
      });
    });

    const pending = this.pendingAsks.get(ask.id)!;
    try {
      for (const [index, question] of questions.entries()) {
        const sent = await this.bot.api.sendMessage(chatId, renderQuestion(question, index, questions.length), {
          message_thread_id: threadId,
          reply_markup: this.askKeyboard(ask.id, index, question, []),
        });
        pending.messages.set(index, sent.message_id);
      }
    } catch (error) {
      // Half the questions posted is not a state anyone can answer out of.
      // Give up cleanly so the caller falls back rather than hanging.
      console.error(`[telegram] could not post questions: ${String(error)}`);
      this.finishAsk(ask.id, undefined);
    }

    return answered;
  }

  private askKeyboard(id: string, index: number, question: AskQuestion, picked: string[]): InlineKeyboard {
    const keyboard = new InlineKeyboard();
    for (const [optionIndex, option] of question.options.entries()) {
      const ticked = question.multiSelect && picked.includes(option.label) ? '✅ ' : '';
      keyboard.text(`${ticked}${buttonLabel(option.label)}`, askCallbackData(id, index, optionIndex)).row();
    }
    // On every question, always. The options are Claude's guesses at what you
    // might want; the whole reason to ask is that it does not know, so a
    // question you can only answer from its own list is one where a wrong guess
    // silently becomes your instruction.
    keyboard.text('✏️ Other…', askCallbackData(id, index, 'other')).row();
    // Only multi-select needs a commit step: a single choice is complete the
    // moment it is tapped, and a Done button there is one tap of pure ceremony.
    if (question.multiSelect) keyboard.text('☑️ Done', askCallbackData(id, index, 'done'));
    return keyboard;
  }

  /** Settle a question set once, cleaning up the timer and the map. */
  private finishAsk(id: string, answers: AskAnswers | undefined): void {
    const pending = this.pendingAsks.get(id);
    if (!pending) return;
    this.pendingAsks.delete(id);
    clearTimeout(pending.timer);
    // Before settling: a question that is over must not still be able to eat the
    // next thing you type. This is the one line standing between "I answered it"
    // and a message meant for Claude vanishing into a resolved promise.
    this.capture.clearAsk(id);
    pending.settle(answers);
  }

  private async expireAsk(id: string): Promise<void> {
    const pending = this.pendingAsks.get(id);
    if (!pending) return;
    this.finishAsk(id, undefined);

    // Strip the keyboards. Buttons that no longer do anything are worse than no
    // buttons: they read as a question still waiting for you.
    for (const messageId of pending.messages.values()) {
      await this.bot.api
        .editMessageReplyMarkup(pending.chatId, messageId, { reply_markup: undefined })
        .catch(() => {});
    }
    await this.bot.api
      .sendMessage(pending.chatId, '⌛ That question timed out — answer it in the session itself.', {
        message_thread_id: pending.threadId,
      })
      .catch(() => {});
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
      // Before the command dispatch, but isTypedAnswer refuses anything starting
      // with '/', so a question waiting on you never swallows /stop.
      if (await this.captureTypedAnswer(msg.conversationId, text)) return;

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
      await this.sendText(msg.conversationId, `⚠️ ${reason}`).catch((sendError) =>
        console.error(`[telegram] failed to relay error to chat: ${sendError instanceof Error ? sendError.message : String(sendError)}`),
      );
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
      await this.sendText(msg.conversationId, `⚠️ Couldn't process that photo: ${reason}`).catch((sendError) =>
        console.error(`[telegram] failed to relay error to chat: ${sendError instanceof Error ? sendError.message : String(sendError)}`),
      );
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
      // Echo *before* handing it over, and let a failure here abort the turn.
      // Both halves are deliberate. Going first is what leaves you a window to
      // /interrupt a misheard instruction; refusing to continue when the echo
      // could not be delivered is what keeps that window from being skipped —
      // acting on a transcript you were never shown is the exact hazard this
      // guards against, so "show it or don't do it" is the invariant.
      await this.echoTranscript(conversationId, text, ctx.message?.message_id);

      // A voice note is a typed answer that was spoken. Routing it to the
      // session instead would be its own trap: you tapped Other, dictated the
      // answer, and it went to Claude as a fresh message while the question sat
      // there still waiting.
      if (await this.captureTypedAnswer(conversationId, text)) return;

      msg.text = text;
      await this.messageHandler?.(msg);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      console.error(`[telegram] audio handler failed: ${reason}`);
      // "Couldn't transcribe that" was a lie on most of the paths that land
      // here — downloading, echoing and the handler itself all fail into this
      // catch, and blaming transcription sends you off to debug whisper when
      // whisper worked fine.
      await this.sendText(conversationId, `⚠️ Voice note failed: ${reason}`).catch((sendError) =>
        console.error(`[telegram] failed to relay error to chat: ${sendError instanceof Error ? sendError.message : String(sendError)}`),
      );
    }
  }

  private async handleCallback(ctx: Filter<Context, 'callback_query:data'>): Promise<void> {
    const userId = String(ctx.from.id);
    const data = ctx.callbackQuery.data;

    // Anyone who can tap these buttons can approve tool use on this machine, or
    // decide what Claude does next — so the allowlist gates them exactly as it
    // gates messages. Checked before the dispatch, so it covers both kinds.
    if (!config.telegram.allowedUsers.has(userId)) {
      await ctx.answerCallbackQuery({ text: 'Not allowed.' });
      return;
    }

    const askCallback = parseAskCallback(data);
    if (askCallback) {
      await this.handleAskCallback(ctx, askCallback);
      return;
    }

    const [kind, id, verdict] = data.split(':');
    if (kind !== 'perm') return;

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

  /**
   * One tap on an AskUserQuestion.
   *
   * Single-select commits on the tap. Multi-select toggles, redrawing the
   * keyboard with ticks, and commits on Done — with at least one option, since
   * an empty answer for a question the tool asked is not an answer.
   */
  private async handleAskCallback(
    ctx: Filter<Context, 'callback_query:data'>,
    callback: AskCallback,
  ): Promise<void> {
    const pending = this.pendingAsks.get(callback.id);
    if (!pending) {
      // Expired, already answered, or answered in the session itself while the
      // phone still showed buttons.
      await ctx.answerCallbackQuery({ text: 'That question is no longer open.' });
      await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => {});
      return;
    }

    const question = pending.questions[callback.questionIndex];
    if (!question) {
      await ctx.answerCallbackQuery({ text: 'Unknown question.' });
      return;
    }

    const picked = pending.picked.get(callback.questionIndex) ?? [];

    if (callback.choice === 'other') {
      this.capture.arm(pending.conversationId, { askId: callback.id, questionIndex: callback.questionIndex });
      await ctx.answerCallbackQuery({ text: 'Type your answer' });
      const header = question.header ? `[${question.header}] ` : '';
      await this.sendText(
        pending.conversationId,
        `✏️ ${header}Type your answer as the next message and it becomes the answer to this ` +
          `question. Tap an option instead to go back to the list; commands still work.`,
      ).catch(() => {});
      return;
    }

    // Any other tap means you changed your mind about typing. Leaving it armed
    // would have your next ordinary message answer a question you just decided
    // with a button.
    this.capture.clearAsk(callback.id);

    if (callback.choice === 'done') {
      if (picked.length === 0) {
        await ctx.answerCallbackQuery({ text: 'Pick at least one first.' });
        return;
      }
      await ctx.answerCallbackQuery({ text: picked.join(', ') });
      await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => {});
      this.settleIfComplete(callback.id);
      return;
    }

    const label = question.options[callback.choice]?.label;
    if (!label) {
      await ctx.answerCallbackQuery({ text: 'Unknown option.' });
      return;
    }

    if (question.multiSelect) {
      const next = picked.includes(label) ? picked.filter((l) => l !== label) : [...picked, label];
      pending.picked.set(callback.questionIndex, next);
      await ctx.answerCallbackQuery({ text: next.length ? next.join(', ') : 'Nothing picked' });
      await ctx
        .editMessageReplyMarkup({
          reply_markup: this.askKeyboard(callback.id, callback.questionIndex, question, next),
        })
        .catch(() => {});
      return;
    }

    pending.picked.set(callback.questionIndex, [label]);
    await ctx.answerCallbackQuery({ text: label });
    // Replace the keyboard with the answer in the text. The tapped button is
    // otherwise indistinguishable from the ones you did not tap, and a phone
    // scrolled back to two questions ago should still say what you chose.
    await ctx
      .editMessageText(`${renderQuestion(question, callback.questionIndex, pending.questions.length)}\n\n✔️ ${label}`, {
        reply_markup: undefined,
      })
      .catch(() => {});
    this.settleIfComplete(callback.id);
  }

  /**
   * Take a typed message as the answer to the question that asked for it.
   *
   * Returns true when it was consumed, which is the caller's signal to stop —
   * this message was an answer, not something to hand the session.
   *
   * A typed answer commits its question outright, multi-select included, rather
   * than joining the ticks and waiting for Done. You typed a considered
   * sentence; making you then press a button to confirm it is ceremony, and a
   * typed answer sitting un-committed next to some ticks is a state nobody can
   * read off the screen.
   */
  private async captureTypedAnswer(conversationId: string, text: string): Promise<boolean> {
    const awaiting = this.capture.consume(conversationId, text);
    if (!awaiting) return false;

    const pending = this.pendingAsks.get(awaiting.askId);
    if (!pending) return false; // Settled between the tap and the typing.

    const answer = text.trim();
    const alreadyTicked = pending.picked.get(awaiting.questionIndex) ?? [];
    pending.picked.set(awaiting.questionIndex, [...alreadyTicked, answer]);

    const messageId = pending.messages.get(awaiting.questionIndex);
    const question = pending.questions[awaiting.questionIndex];
    if (messageId !== undefined && question) {
      // Record it on the question itself. Scrolled back to later, a bare
      // keyboard says nothing about what you typed three messages ago.
      await this.bot.api
        .editMessageText(
          pending.chatId,
          messageId,
          `${renderQuestion(question, awaiting.questionIndex, pending.questions.length)}\n\n✔️ ${answer}`,
          { reply_markup: undefined },
        )
        .catch(() => {});
    }

    this.settleIfComplete(awaiting.askId);
    return true;
  }

  /** Resolve once every question has a pick — not before, and only once. */
  private settleIfComplete(id: string): void {
    const pending = this.pendingAsks.get(id);
    if (!pending) return;

    const complete = pending.questions.every(
      (_question, index) => (pending.picked.get(index) ?? []).length > 0,
    );
    if (!complete) return;

    this.finishAsk(id, toAnswers(pending.questions, pending.picked));
  }
}

function split(conversationId: string): { chatId: number; threadId?: number } {
  const [chat, thread] = conversationId.split(':');
  const threadId = Number(thread);
  return { chatId: Number(chat), threadId: threadId > 0 ? threadId : undefined };
}


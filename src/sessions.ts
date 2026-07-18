import {
  query,
  type PermissionMode,
  type Query,
  type SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk';
import { AsyncQueue } from './queue.js';
import type { Registry, Entry } from './registry.js';
import type { PermissionAsk, QuestionAsk } from './frontend.js';
import { type AskAnswers, type AskQuestion, newAskId } from './asks.js';
import { config } from './config.js';

type Live = {
  entry: Entry;
  input: AsyncQueue<SDKUserMessage>;
  query: Query;
  pump: Promise<void>;
};

export type SessionDeps = {
  registry: Registry;
  /** Deliver assistant output back to the conversation. */
  emit(conversationId: string, text: string): Promise<void>;
  /** Ask the human. Resolving `false` denies the tool call. */
  confirm(conversationId: string, ask: PermissionAsk): Promise<boolean>;
  /** Put an AskUserQuestion to the human. Resolves undefined if nobody answered. */
  ask(conversationId: string, ask: QuestionAsk): Promise<AskAnswers | undefined>;
  /** A turn just finished. Optional, best-effort, and never allowed to throw. */
  turnEnded?(conversationId: string): Promise<void>;
};

/**
 * Owns the live Claude sessions. One `query()` per conversation, kept alive by
 * an AsyncQueue of user messages, so a session keeps its context across turns
 * instead of restarting per message.
 */
/** Not a permission gate but the channel a question is answered through — see spawn(). */
const ASK_USER_QUESTION = 'AskUserQuestion';

export const PERMISSION_MODES: PermissionMode[] = [
  'default',
  'acceptEdits',
  'plan',
  'dontAsk',
  'bypassPermissions',
];

export class SessionManager {
  private live = new Map<string, Live>();
  /** Conversations with a turn in flight — pushed, not yet finished. */
  private working = new Set<string>();

  constructor(private readonly deps: SessionDeps) {}

  /**
   * Is Claude still working on the last thing sent here?
   *
   * Only meaningful for broker-owned sessions. A *watched* session runs in
   * someone's VS Code and this process never sees its turns, so this answers
   * false for those — the caller must not read that as "idle".
   *
   * Exists for /loop, which is the one caller that can sensibly skip: a person
   * typing a second message mid-turn means it, and it queues. A timer firing
   * again because the last answer is still being written means nothing, and
   * queueing it builds a backlog that never drains.
   */
  isWorking(conversationId: string): boolean {
    return this.working.has(conversationId);
  }

  /** Per-session overrides survive a restart, so they apply on resume too. */
  async setPermissionMode(conversationId: string, mode: PermissionMode): Promise<void> {
    const entry = this.require(conversationId);
    entry.permissionMode = mode;
    this.deps.registry.put(entry);
    await this.live.get(conversationId)?.query.setPermissionMode(mode);
  }



  /** Register a conversation without starting Claude yet. */
  register(conversationId: string, cwd: string, title: string): Entry {
    const entry: Entry = { conversationId, cwd, title };
    this.deps.registry.put(entry);
    return entry;
  }

  async send(conversationId: string, text: string): Promise<void> {
    const session = this.live.get(conversationId) ?? (await this.spawn(conversationId));
    // Marked before the push, not after: the queue can hand the message
    // straight to a waiting consumer, so `result` may land before a later line
    // here would have set this — and the flag would then be stuck on forever.
    this.working.add(conversationId);
    session.input.push({
      type: 'user',
      message: { role: 'user', content: text },
      parent_tool_use_id: null,
    });
  }

  async interrupt(conversationId: string): Promise<void> {
    await this.live.get(conversationId)?.query.interrupt();
  }

  /** Close the running process. The transcript survives; a later turn resumes it. */
  async stop(conversationId: string): Promise<void> {
    const session = this.live.get(conversationId);
    if (!session) return;
    this.live.delete(conversationId);
    session.input.close();
    session.query.close();
    await session.pump.catch(() => {});
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.live.keys()].map((id) => this.stop(id)));
  }

  private require(conversationId: string): Entry {
    const entry = this.deps.registry.get(conversationId);
    if (!entry) throw new Error('No session here yet. Start one with /new.');
    return entry;
  }

  /**
   * Start (or resume) the Claude session backing a conversation. Resuming is
   * what makes the broker restart-safe: the session id is on disk, so a
   * restarted broker picks the conversation back up mid-thread.
   */
  private async spawn(conversationId: string): Promise<Live> {
    const entry = this.require(conversationId);

    const input = new AsyncQueue<SDKUserMessage>();
    const q = query({
      prompt: input,
      options: {
        cwd: entry.cwd,
        // BROKER_MODEL is the model every (re)start of this session gets. A
        // `/model` sent through the passthrough is per-process — Claude Code says
        // "for this session only" and means the running one — so it does not
        // survive /stop. Verified, not assumed.
        model: config.model,
        // /mode, on the other hand, is the broker's: no native command sets it.
        permissionMode: (entry.permissionMode as PermissionMode) ?? config.permissionMode,
        // Without these rules `canUseTool` is never called for Bash/Edit — the
        // permission flow only prompts when a rule says it must.
        //
        // AskUserQuestion is appended rather than left to BROKER_ASK_TOOLS, and
        // it is not there as a permission gate: canUseTool is the only place the
        // broker can see the question at all, and the tool is only offered to
        // the model when a canUseTool handler exists. Leaving it to the env var
        // would mean a default install where Claude asks a question no one on
        // the phone can see, let alone answer.
        settings: { permissions: { ask: [...new Set([...config.askTools, ASK_USER_QUESTION])] } },
        resume: entry.sessionId,
        canUseTool: async (toolName, toolInput) => {
          if (toolName === ASK_USER_QUESTION) return this.answerQuestion(conversationId, toolInput);

          const allowed = await this.deps.confirm(conversationId, {
            toolName,
            preview: preview(toolInput),
          });
          return allowed
            ? { behavior: 'allow', updatedInput: toolInput }
            : { behavior: 'deny', message: 'Denied by the user from Telegram.' };
        },
      },
    });

    const session: Live = { entry, input, query: q, pump: Promise.resolve() };
    session.pump = this.consume(session);
    this.live.set(conversationId, session);
    return session;
  }

  /**
   * Answer an in-flight AskUserQuestion from Telegram.
   *
   * Allowing the call with `answers` filled in is what makes this a real answer
   * rather than a relayed note: the tool then resolves with the harness's own
   * "Your questions have been answered" result and the turn carries on as if you
   * had picked in the terminal. Denying — the obvious alternative — reaches the
   * model as a refusal, which it reasonably reads as "do not proceed".
   *
   * Nobody answering is not an error. Say so plainly and let Claude decide what
   * to do without a choice it was never given; blocking the turn forever is the
   * one outcome that helps no one.
   */
  private async answerQuestion(
    conversationId: string,
    toolInput: Record<string, unknown>,
  ): Promise<{ behavior: 'allow'; updatedInput: Record<string, unknown> } | { behavior: 'deny'; message: string }> {
    const questions = (toolInput.questions ?? []) as AskQuestion[];
    const answers = Array.isArray(questions)
      ? await this.deps.ask(conversationId, {
          id: newAskId(),
          questions,
          expiresAt: Date.now() + config.askTimeoutMs,
        })
      : undefined;

    if (!answers) {
      return {
        behavior: 'deny',
        message:
          'Nobody answered from Telegram in time. Do not ask again — carry on with your ' +
          'best judgement, and say which assumption you made.',
      };
    }
    return { behavior: 'allow', updatedInput: { ...toolInput, answers } };
  }

  /** Drain the SDK's message stream and forward what a human wants to see. */
  private async consume(session: Live): Promise<void> {
    const { conversationId } = session.entry;
    try {
      for await (const message of session.query) {
        if (message.type === 'system' && message.subtype === 'init') {
          // First time through, this is where we learn the session id to resume.
          if (session.entry.sessionId !== message.session_id) {
            session.entry.sessionId = message.session_id;
            this.deps.registry.put(session.entry);
          }
          continue;
        }

        if (message.type === 'assistant') {
          const text = textOf(message.message.content);
          if (text) await this.deps.emit(conversationId, text);
          continue;
        }

        if (message.type === 'result') {
          // The turn boundary, success or not: `result` is the last message of
          // every turn, which is what makes it the one place this can clear.
          this.working.delete(conversationId);
          if (message.subtype !== 'success') {
            await this.deps.emit(conversationId, `⚠️ Session ended: ${message.subtype}`);
          }
          // Swallowed on purpose: a decoration that throws here escapes into
          // consume's catch, which reports it as a session error and kills the
          // pump. The session must outlive anything the quota check does.
          await Promise.resolve(this.deps.turnEnded?.(conversationId)).catch(() => {});
        }
      }
    } catch (error) {
      await this.deps.emit(conversationId, `⚠️ Session error: ${String(error)}`);
    } finally {
      this.live.delete(conversationId);
      // A session that died mid-turn never sends `result`. Leaving the flag set
      // would make every future /loop fire skip itself, forever, silently.
      this.working.delete(conversationId);
    }
  }
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((block): block is { type: 'text'; text: string } => block?.type === 'text')
    .map((block) => block.text)
    .join('\n')
    .trim();
}

/** One line the human can actually judge before allowing a tool call. */
function preview(input: Record<string, unknown>): string {
  const interesting = input.command ?? input.file_path ?? input.path ?? input.pattern;
  const text = typeof interesting === 'string' ? interesting : JSON.stringify(input);
  return text.length > 300 ? `${text.slice(0, 300)}…` : text;
}

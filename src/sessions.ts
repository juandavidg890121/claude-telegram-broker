import {
  query,
  type PermissionMode,
  type Query,
  type SDKRateLimitInfo,
  type SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk';
import { AsyncQueue } from './queue.js';
import type { Registry, Entry } from './registry.js';
import type { PermissionAsk } from './frontend.js';
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
};

/**
 * Owns the live Claude sessions. One `query()` per conversation, kept alive by
 * an AsyncQueue of user messages, so a session keeps its context across turns
 * instead of restarting per message.
 */
export const PERMISSION_MODES: PermissionMode[] = [
  'default',
  'acceptEdits',
  'plan',
  'dontAsk',
  'bypassPermissions',
];

export type Cost = { turns: number; usd: number; input: number; output: number };

export class SessionManager {
  private live = new Map<string, Live>();
  private cost = new Map<string, Cost>();
  /**
   * Quota is account-wide, not per session, and there is no way to ask for it —
   * the SDK only pushes `rate_limit_event` messages as they change. So keep the
   * latest of each window as it goes past.
   */
  private rateLimits = new Map<string, SDKRateLimitInfo>();

  constructor(private readonly deps: SessionDeps) {}

  /** Per-session overrides survive a restart, so they apply on resume too. */
  async setPermissionMode(conversationId: string, mode: PermissionMode): Promise<void> {
    const entry = this.require(conversationId);
    entry.permissionMode = mode;
    this.deps.registry.put(entry);
    await this.live.get(conversationId)?.query.setPermissionMode(mode);
  }

  async setModel(conversationId: string, model: string): Promise<void> {
    const entry = this.require(conversationId);
    entry.model = model;
    this.deps.registry.put(entry);
    await this.live.get(conversationId)?.query.setModel(model);
  }

  /** Models this build of Claude Code actually offers. Needs a live session. */
  async supportedModels(conversationId: string): Promise<string[]> {
    const session = this.live.get(conversationId);
    if (!session) return [];
    const models = await session.query.supportedModels();
    return models.map((m) => m.value ?? m.displayName);
  }

  costOf(conversationId: string): Cost | undefined {
    return this.cost.get(conversationId);
  }

  quota(): SDKRateLimitInfo[] {
    return [...this.rateLimits.values()];
  }

  /** Register a conversation without starting Claude yet. */
  register(conversationId: string, cwd: string, title: string): Entry {
    const entry: Entry = { conversationId, cwd, title };
    this.deps.registry.put(entry);
    return entry;
  }

  async send(conversationId: string, text: string): Promise<void> {
    const session = this.live.get(conversationId) ?? (await this.spawn(conversationId));
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
        // Per-session overrides win over the broker-wide defaults.
        model: entry.model ?? config.model,
        permissionMode: (entry.permissionMode as PermissionMode) ?? config.permissionMode,
        // Without these rules `canUseTool` is never called for Bash/Edit — the
        // permission flow only prompts when a rule says it must.
        settings: { permissions: { ask: config.askTools } },
        resume: entry.sessionId,
        canUseTool: async (toolName, toolInput) => {
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

        // Quota is only ever pushed, never queryable — bank it as it goes past.
        if (message.type === 'rate_limit_event') {
          const info = message.rate_limit_info;
          this.rateLimits.set(info.rateLimitType ?? 'unknown', info);
          continue;
        }

        if (message.type === 'result') {
          const running = this.cost.get(conversationId) ?? { turns: 0, usd: 0, input: 0, output: 0 };
          this.cost.set(conversationId, {
            turns: running.turns + 1,
            usd: running.usd + message.total_cost_usd,
            input: running.input + message.usage.input_tokens,
            output: running.output + message.usage.output_tokens,
          });
          if (message.subtype !== 'success') {
            await this.deps.emit(conversationId, `⚠️ Session ended: ${message.subtype}`);
          }
        }
      }
    } catch (error) {
      await this.deps.emit(conversationId, `⚠️ Session error: ${String(error)}`);
    } finally {
      this.live.delete(conversationId);
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

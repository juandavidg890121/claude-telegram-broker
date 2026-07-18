import { join } from 'node:path';
import { ASK_TIMEOUT_SEC } from './asks.js';

/**
 * The /watch hooks, and how to fold them into an existing settings.json.
 *
 * Shared by print-hooks (which shows them) and setup (which writes them) so the
 * two can never drift: a hook the installer merges but the doc never mentions,
 * or vice versa, is exactly the silent half-configuration this whole flow
 * exists to prevent.
 */

export type HookEntry = { type: 'command'; command: string; timeout?: number };
export type HookMatcher = { matcher?: string; hooks: HookEntry[] };
export type HookConfig = Record<string, HookMatcher[]>;

/** Absolute path to the tsx binary in this checkout. */
export const tsxPath = (root: string): string => join(root, 'node_modules', '.bin', 'tsx');

const command = (root: string, script: string, withEnv: boolean): string =>
  [
    tsxPath(root),
    withEnv ? `--env-file-if-exists=${join(root, '.env')}` : '',
    join(root, 'scripts', 'mirror', script),
  ]
    .filter(Boolean)
    .join(' ');

/**
 * How long Claude Code lets the AskUserQuestion hook run, in seconds.
 *
 * Derived from the wait itself, never written by hand. The hook blocks for
 * ASK_TIMEOUT_SEC waiting for a tap, so a `timeout` at or below that would have
 * Claude Code kill it a moment *before* it gives up — turning the one path that
 * reports cleanly into a killed process, on every unanswered question. The
 * margin covers startup and the final write.
 */
export const ASK_HOOK_TIMEOUT_SEC = ASK_TIMEOUT_SEC + 30;

/**
 * The three hooks /watch needs, with this checkout's real paths filled in.
 *
 * Stop and AskUserQuestion send to Telegram, so they read the broker's .env for
 * the token; SessionStart only arms the poller and needs none.
 */
export function buildHookConfig(root: string): HookConfig {
  return {
    Stop: [{ hooks: [{ type: 'command', command: command(root, 'stop-hook.ts', true) }] }],
    SessionStart: [{ hooks: [{ type: 'command', command: command(root, 'session-start-hook.ts', false) }] }],
    // The matcher scopes this to AskUserQuestion. The hook re-checks tool_name,
    // but a config written from here should not lean on that belt when it can
    // print the braces.
    PreToolUse: [
      {
        matcher: 'AskUserQuestion',
        hooks: [
          {
            type: 'command',
            command: command(root, 'ask-user-question-hook.ts', true),
            timeout: ASK_HOOK_TIMEOUT_SEC,
          },
        ],
      },
    ],
  };
}

/** Every command string in a hook config, for spotting ours already present. */
function commandsOf(matchers: HookMatcher[] | undefined): Set<string> {
  return new Set((matchers ?? []).flatMap((matcher) => matcher.hooks.map((hook) => hook.command)));
}

/**
 * Fold this checkout's hooks into a parsed settings.json, returning the new
 * object without mutating the old one.
 *
 * Idempotent, and that is the point: setup can be re-run, and a user may have
 * pasted the block once already. A matcher whose command is identical to one
 * we would add is left alone rather than duplicated — Claude Code would run a
 * doubled hook twice, sending every reply to Telegram twice.
 *
 * Everything already in settings is preserved: other tools' hooks, other event
 * names, and other keys entirely. We only ever append to the event arrays we
 * own, never replace them.
 */
export function mergeHooks(settings: Record<string, unknown>, incoming: HookConfig): Record<string, unknown> {
  const existingHooks = (settings.hooks ?? {}) as HookConfig;
  const mergedHooks: HookConfig = { ...existingHooks };

  for (const [event, matchers] of Object.entries(incoming)) {
    const already = commandsOf(existingHooks[event]);
    const toAdd = matchers.filter((matcher) => matcher.hooks.some((hook) => !already.has(hook.command)));
    mergedHooks[event] = [...(existingHooks[event] ?? []), ...toAdd];
  }

  return { ...settings, hooks: mergedHooks };
}

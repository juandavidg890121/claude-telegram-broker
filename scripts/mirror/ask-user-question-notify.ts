/**
 * PreToolUse hook: push a Telegram notification the instant AskUserQuestion
 * fires in a watched session.
 *
 * AskUserQuestion is not a permission gate — canUseTool (sessions.ts) only ever
 * fires for the tools named in `permissions.ask`, and it isn't an MCP
 * elicitation either (Elicitation/ElicitationResult cover MCP-server-initiated
 * requests only), so nothing already mirrors it. Left alone, a question posed in
 * a VS Code window with nobody watching the screen sits frozen with zero signal
 * that it's waiting — indistinguishable from the session having quietly
 * finished.
 *
 * This can't answer for you: there is no SDK hook that injects a response into
 * an in-flight AskUserQuestion, so the reply still happens in VS Code. What it
 * closes is the "I had no idea it was waiting" half, which is the half that
 * costs hours. Pair with `askUserQuestionTimeout` in settings.json (60s/5m/10m)
 * so a question that never gets answered doesn't block forever either.
 *
 * Install with `pnpm run print-hooks`, which prints this with real paths filled
 * in — the token stays out of settings.json, see README.
 */
import type { AskUserQuestionInput } from '@anthropic-ai/claude-agent-sdk/sdk-tools';
import { findWatched } from '../../src/broker-state.js';
import { readStdin, notify } from '../../src/hook-telegram.js';
import { summarize } from '../../src/ask-user-question.js';

const TAG = 'ask-user-question-notify';

async function main(): Promise<void> {
  const payload = JSON.parse(await readStdin()) as {
    session_id?: string;
    tool_name?: string;
    tool_input?: unknown;
  };

  // The matcher should already scope this to AskUserQuestion; a settings.json
  // that forgot it would otherwise notify on every tool call in the session.
  if (payload.tool_name !== 'AskUserQuestion') return;

  const sessionId = payload.session_id;
  if (!sessionId) return;

  const entry = findWatched(sessionId);
  if (!entry) return; // Not watched from Telegram: nowhere to push to, stay silent.

  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    // Loud, matching stop-hook.ts: from the phone, "not watched" and
    // "misconfigured" look identical, and the silent version is unfindable.
    console.error(
      `[${TAG}] this session is watched from Telegram but TELEGRAM_BOT_TOKEN is unset — ` +
        'no notification sent. Point the hook at the broker .env (see README).',
    );
    return;
  }

  // No backticks around the id: this goes out without parse_mode, so Markdown
  // arrives as literal punctuation rather than formatting.
  const text =
    `❓ Waiting on you in ${sessionId.slice(0, 8)} (VS Code) — answer there, not here:\n\n` +
    summarize(payload.tool_input as Partial<AskUserQuestionInput> | undefined);

  await notify(entry.conversationId, token, text, TAG);
}

await main();

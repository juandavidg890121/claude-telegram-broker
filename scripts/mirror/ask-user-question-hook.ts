/**
 * PreToolUse hook: answer an AskUserQuestion from Telegram, in a watched session.
 *
 * This is the half /watch was missing. The Stop hook mirrors what Claude *said*;
 * this mirrors what Claude *asks*, and — unlike the notification it replaces —
 * brings the answer back. Filling `answers` in and letting the tool run is what
 * makes it a real answer: the tool resolves with the harness's own "Your
 * questions have been answered" result and the turn continues exactly as if you
 * had picked in the terminal.
 *
 * It cannot listen for the tap itself. Telegram's getUpdates admits one poller
 * per token and the broker owns it, so the question goes out through the file
 * handoff in asks.ts and this process blocks on the answer coming back.
 *
 * Three ways out, and all three leave the session usable:
 *   • answered      -> emit the answers, turn continues
 *   • broker down   -> exit immediately, question falls through to the terminal
 *   • nobody tapped -> exit at the deadline, question falls through to the terminal
 *
 * Falling through is why this stays silent on stdout in the last two cases: no
 * hook output means no decision, and Claude Code puts the question up in the UI
 * as it always would. The failure mode this replaces — a phone showing options
 * that do nothing — is strictly worse than a question you answer at the desk.
 *
 * Install with `pnpm run print-hooks`, which fills in real paths and the matching
 * `timeout`. The token stays out of settings.json — see README.
 */
import type { AskUserQuestionInput } from '@anthropic-ai/claude-agent-sdk/sdk-tools';
import { findWatched } from '../../src/broker-state.js';
import { readStdin, notify } from '../../src/hook-telegram.js';
import { summarize } from '../../src/ask-user-question.js';
import {
  ASK_TIMEOUT_SEC,
  brokerAlive,
  clearAsk,
  newAskId,
  waitForAnswer,
  writeAskRequest,
  type AskQuestion,
} from '../../src/asks.js';

const TAG = 'ask-user-question-hook';

async function main(): Promise<void> {
  const payload = JSON.parse(await readStdin()) as {
    session_id?: string;
    tool_name?: string;
    tool_input?: unknown;
  };

  // The matcher should already scope this to AskUserQuestion; a settings.json
  // that forgot it would otherwise block on every tool call in the session.
  if (payload.tool_name !== 'AskUserQuestion') return;

  const sessionId = payload.session_id;
  if (!sessionId) return;

  const entry = findWatched(sessionId);
  if (!entry) return; // Not watched from Telegram: nowhere to ask, stay silent.

  const input = payload.tool_input as Partial<AskUserQuestionInput> | undefined;
  const questions = (input?.questions ?? []) as AskQuestion[];
  if (!Array.isArray(questions) || questions.length === 0) return;

  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    // Loud, matching stop-hook.ts: from the phone, "not watched" and
    // "misconfigured" look identical, and the silent version is unfindable.
    console.error(
      `[${TAG}] this session is watched from Telegram but TELEGRAM_BOT_TOKEN is unset — ` +
        'the question was not sent. Point the hook at the broker .env (see README).',
    );
    return;
  }

  // Checked before anything blocks. A stopped broker will never claim the
  // request, so without this every question in every watched session would stall
  // the session for the full timeout before falling through to the terminal it
  // could have gone to instantly.
  if (!brokerAlive()) {
    console.error(`[${TAG}] the broker is not running — answer this one in the session.`);
    return;
  }

  const id = newAskId();
  const expiresAt = Date.now() + ASK_TIMEOUT_SEC * 1000;
  writeAskRequest({ id, sessionId, questions, at: new Date().toISOString(), expiresAt });

  try {
    const answers = await waitForAnswer(sessionId, id, expiresAt);
    if (!answers) {
      await notify(
        entry.conversationId,
        token,
        `⌛ No answer in ${Math.round(ASK_TIMEOUT_SEC / 60)} min, so this went back to the session:\n\n` +
          summarize(input),
        TAG,
      );
      return;
    }

    // stdout is the hook's return channel and nothing else may be written to it
    // — every diagnostic in this file goes to stderr for that reason.
    console.log(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'allow',
          permissionDecisionReason: 'Answered from Telegram.',
          updatedInput: { ...(payload.tool_input as object), answers },
        },
      }),
    );
  } finally {
    // Always, including the timeout path: a leftover request is what tells the
    // broker a tap still means something, and a tap that lands after this
    // process is gone must be treated as late rather than delivered to nobody.
    clearAsk(sessionId, id);
  }
}

await main();

/**
 * Drives the /watch answering path against a real Claude session: a real
 * AskUserQuestion, the real hook script, and a stand-in broker in place of the
 * phone.
 *
 * The unit tests cover each link — the file handoff in asks.test.ts, the hook's
 * output in ask-hook.test.ts — and every one of them can pass while the chain is
 * broken, because the claim they cannot make is the only one that matters: that
 * Claude Code accepts `updatedInput` from a PreToolUse hook and resolves the
 * tool with those answers. That belongs to the harness, so it is checked against
 * the harness or not at all.
 *
 * Everything runs in a temp sandbox: its own mirror directory and its own state
 * file, so it never touches a real watched session or your broker's registry.
 *
 *   npx tsx src/smoke-watch.ts
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const sandbox = mkdtempSync(join(tmpdir(), 'broker-smoke-watch-'));
process.env.BROKER_MIRROR_DIR = join(sandbox, 'mirror');
process.env.BROKER_STATE_FILE = join(sandbox, 'state.json');
process.env.BROKER_ASK_TIMEOUT_SEC = '90';
// The hook refuses to ask without one, and says so loudly. Never sent anywhere:
// only the timeout path talks to Telegram, and this run answers.
process.env.TELEGRAM_BOT_TOKEN ??= 'smoke-token';

// Imported after the env is set. mirror.ts fixes MIRROR_ROOT at module scope, so
// a static import would bind it to the real ~/.claude before any of this ran.
const { query } = await import('@anthropic-ai/claude-agent-sdk');
const { startAskWatcher } = await import('./asks.js');

const PICK = 'Vue';
const root = process.cwd();
let sessionId = '';
let asked: string[] = [];

/** The phone: whatever it is asked, it taps Vue. */
const watcher = startAskWatcher(
  () => (sessionId ? [sessionId] : []),
  async (request) => {
    asked = request.questions.map((question) => question.question);
    console.log(`  [phone] ${JSON.stringify(asked)} -> tapping ${PICK}`);
    return Object.fromEntries(request.questions.map((question) => [question.question, PICK]));
  },
  100,
);

const hookCommand = [
  join(root, 'node_modules', '.bin', 'tsx'),
  join(root, 'scripts', 'mirror', 'ask-user-question-hook.ts'),
].join(' ');

const session = query({
  prompt:
    `Use the AskUserQuestion tool to ask whether I prefer React or ${PICK}. ` +
    'Then reply with exactly PICKED=<my choice> and nothing else.',
  options: {
    cwd: root,
    settings: {
      // AskUserQuestion is only offered to the model when there is a way to
      // answer it, so both of these are load-bearing: the ask rule plus a
      // canUseTool handler. Without them the tool is not in the toolset at all
      // and this smoke test passes by never testing anything.
      permissions: { ask: ['AskUserQuestion'] },
      hooks: {
        PreToolUse: [
          { matcher: 'AskUserQuestion', hooks: [{ type: 'command', command: hookCommand, timeout: 120 }] },
        ],
      },
    },
    canUseTool: async (_toolName, toolInput) => ({ behavior: 'allow', updatedInput: toolInput }),
  },
});

const texts: string[] = [];
for await (const message of session) {
  if (message.type === 'system' && message.subtype === 'init') {
    sessionId = message.session_id;
    // The watch has to exist before the hook fires; the hook reads this file at
    // that moment, several seconds from now.
    writeFileSync(
      process.env.BROKER_STATE_FILE!,
      JSON.stringify([
        { conversationId: '-100123:7', sessionId, cwd: root, title: 'smoke-watch', watch: true },
      ]),
    );
    console.log(`  [session] ${sessionId}`);
    continue;
  }
  if (message.type === 'assistant') {
    for (const block of message.message.content as { type: string; text?: string; name?: string }[]) {
      if (block.type === 'tool_use') console.log(`  [tool_use] ${block.name}`);
      if (block.type === 'text' && block.text?.trim()) {
        texts.push(block.text.trim());
        console.log(`  [claude] ${block.text.trim().slice(0, 90)}`);
      }
    }
  }
}
clearInterval(watcher);

const reachedPhone = asked.length > 0;
// Only meaningful because the phone picks a fixed option: a model left to guess
// could say PICKED=Vue on its own and this would pass having answered nothing.
const answerLanded = texts.some((text) => new RegExp(`PICKED=${PICK}`, 'i').test(text));

console.log('\n--- results ---');
console.log(`hook reached the broker : ${reachedPhone ? 'yes' : 'NO — the question never left the session'}`);
console.log(`tap became the result   : ${answerLanded ? 'yes' : 'NO — Claude never got the answer'}`);
process.exit(reachedPhone && answerLanded ? 0 : 1);

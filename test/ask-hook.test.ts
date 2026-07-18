/**
 * The /watch half, end to end: the real hook script, spawned the way Claude Code
 * spawns it, against a stand-in broker.
 *
 * Spawned rather than imported, because every interesting property here is a
 * property of the *process*: it reads stdin, it writes exactly one JSON object
 * to stdout and diagnostics to stderr, and it blocks. Importing main() would
 * test none of that — and stdout discipline in particular is the difference
 * between an answered question and a Claude Code that cannot parse the reply.
 *
 * What is deliberately not tested here is the phone. The stand-in broker plays
 * the part of a human tapping a button; the buttons themselves are unit-tested
 * in ask-user-question.test.ts, and the file handoff in asks.test.ts.
 */
import assert from 'node:assert/strict';
import { describe, it, before, after, beforeEach } from 'node:test';
import { spawn } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const HOOK = join(root, 'scripts', 'mirror', 'ask-user-question-hook.ts');
const TSX = join(root, 'node_modules', '.bin', 'tsx');

const SESSION = '11111111-2222-3333-4444-555555555555';
const CONVERSATION = '-1001234567890:42';

const sandbox = mkdtempSync(join(tmpdir(), 'broker-askhook-'));
const mirrorDir = join(sandbox, 'mirror');
const stateFile = join(sandbox, 'state.json');

/** What Claude Code pipes into a PreToolUse hook. */
const payload = (overrides: Record<string, unknown> = {}) =>
  JSON.stringify({
    session_id: SESSION,
    tool_name: 'AskUserQuestion',
    tool_input: {
      questions: [
        {
          question: 'Which library?',
          header: 'Library',
          options: [{ label: 'React' }, { label: 'Vue' }],
          multiSelect: false,
        },
      ],
    },
    ...overrides,
  });

type Run = { stdout: string; stderr: string; code: number | null };

function runHook(stdin: string, env: Record<string, string> = {}): Promise<Run> {
  const child = spawn(TSX, [HOOK], {
    env: {
      ...process.env,
      BROKER_MIRROR_DIR: mirrorDir,
      BROKER_STATE_FILE: stateFile,
      TELEGRAM_BOT_TOKEN: 'test-token',
      TELEGRAM_API_BASE: telegramUrl,
      BROKER_ASK_TIMEOUT_SEC: '30',
      ...env,
    },
  });
  child.stdin.end(stdin);

  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => (stdout += chunk));
  child.stderr.on('data', (chunk) => (stderr += chunk));
  return new Promise((resolve) => child.on('close', (code) => resolve({ stdout, stderr, code })));
}

/** A broker that answers with `answers`, or never answers if given undefined. */
function fakeBroker(answers: Record<string, string> | undefined): { stop: () => void; asked: () => number } {
  let count = 0;
  const watcher = asks.startAskWatcher(
    () => [SESSION],
    async (request) => {
      count++;
      return answers ? Object.fromEntries(request.questions.map((q) => [q.question, answers[q.question]])) : undefined;
    },
    20,
  );
  return { stop: () => clearInterval(watcher), asked: () => count };
}

let telegramUrl = '';
let telegram: Server;
let sent: { chat_id: string; text: string }[] = [];
let asks: typeof import('../src/asks.js');

before(async () => {
  process.env.BROKER_MIRROR_DIR = mirrorDir;
  asks = await import('../src/asks.js');

  telegram = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      sent.push(JSON.parse(body));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, result: { message_id: 1 } }));
    });
  });
  await new Promise<void>((resolve) => telegram.listen(0, '127.0.0.1', resolve));
  const address = telegram.address();
  telegramUrl = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
});

after(() => {
  telegram.close();
  rmSync(sandbox, { recursive: true, force: true });
});

beforeEach(() => {
  sent = [];
  rmSync(join(mirrorDir, SESSION), { recursive: true, force: true });
  writeFileSync(
    stateFile,
    JSON.stringify([{ conversationId: CONVERSATION, sessionId: SESSION, cwd: '/tmp', title: 'demo', watch: true }]),
  );
  asks.touchBrokerHeartbeat();
});

describe('the AskUserQuestion hook, watched session', () => {
  it('emits the answer as the tool input Claude Code should use', async () => {
    const broker = fakeBroker({ 'Which library?': 'Vue' });
    const run = await runHook(payload());
    broker.stop();

    assert.equal(run.code, 0);
    const output = JSON.parse(run.stdout);
    assert.equal(output.hookSpecificOutput.hookEventName, 'PreToolUse');
    assert.equal(output.hookSpecificOutput.permissionDecision, 'allow');
    // Keyed by question text, and alongside the original questions rather than
    // replacing them: the tool needs both halves to resolve.
    assert.deepEqual(output.hookSpecificOutput.updatedInput.answers, { 'Which library?': 'Vue' });
    assert.equal(output.hookSpecificOutput.updatedInput.questions.length, 1);
  });

  it('writes nothing but JSON to stdout', async () => {
    // A stray log line here is not a cosmetic problem: Claude Code parses this
    // stream, so one console.log turns every answer into a parse failure.
    const broker = fakeBroker({ 'Which library?': 'React' });
    const run = await runHook(payload());
    broker.stop();
    assert.doesNotThrow(() => JSON.parse(run.stdout));
  });

  it('cleans up after itself, so a late tap is recognisable as late', async () => {
    const broker = fakeBroker({ 'Which library?': 'React' });
    const run = await runHook(payload());
    broker.stop();

    assert.equal(run.code, 0);
    // Every trace, not just the request: a leftover answer file is what a
    // restarted hook would read as an answer to a question nobody asked.
    assert.deepEqual(readdirSync(asks.asksDir(SESSION)), [], 'nothing left in the asks directory');
  });

  it('stays silent for a session no topic is watching', async () => {
    writeFileSync(stateFile, JSON.stringify([]));
    const broker = fakeBroker({ 'Which library?': 'React' });
    const run = await runHook(payload());
    broker.stop();

    assert.equal(run.stdout, '', 'no decision, so the question goes up in the terminal as usual');
    assert.equal(broker.asked(), 0);
  });

  it('stays silent for any other tool', async () => {
    // The matcher should scope this, but a settings.json that lost it would
    // otherwise have every Bash call in the session block on a phone.
    const broker = fakeBroker({ 'Which library?': 'React' });
    const run = await runHook(payload({ tool_name: 'Bash', tool_input: { command: 'ls' } }));
    broker.stop();
    assert.equal(run.stdout, '');
    assert.equal(broker.asked(), 0);
  });

  it('gives up immediately when the broker is not running', async () => {
    // The point of the broker heartbeat. Without it this blocks the real
    // session for the full timeout before falling through to the terminal it
    // could have reached instantly.
    rmSync(asks.brokerHeartbeatPath(), { force: true });
    const started = Date.now();
    const run = await runHook(payload());

    assert.equal(run.stdout, '');
    assert.match(run.stderr, /broker is not running/);
    assert.ok(Date.now() - started < 15_000, 'returned without waiting out the deadline');
  });

  it('falls through to the terminal when nobody answers, and says so on the phone', async () => {
    const broker = fakeBroker(undefined);
    const run = await runHook(payload(), { BROKER_ASK_TIMEOUT_SEC: '2' });
    broker.stop();

    assert.equal(run.stdout, '', 'no decision means Claude Code puts the question up itself');
    assert.equal(run.code, 0, 'a question nobody answered is not a hook failure');
    assert.ok(
      sent.some((message) => /went back to the session/.test(message.text)),
      'the phone is told its buttons are dead, rather than left showing them',
    );
    assert.equal(sent[0]?.chat_id, '-1001234567890');
  });

  it('does not block on a payload with no questions in it', async () => {
    const broker = fakeBroker({ 'Which library?': 'React' });
    const run = await runHook(payload({ tool_input: { questions: [] } }));
    broker.stop();
    assert.equal(run.stdout, '');
    assert.equal(broker.asked(), 0);
  });

  it('says so loudly when it is watched but has no token', async () => {
    const broker = fakeBroker({ 'Which library?': 'React' });
    const run = await runHook(payload(), { TELEGRAM_BOT_TOKEN: '' });
    broker.stop();
    // From the phone, "not watched" and "misconfigured" look identical; the
    // silent version of this bug is unfindable.
    assert.match(run.stderr, /TELEGRAM_BOT_TOKEN is unset/);
    assert.equal(run.stdout, '');
  });
});

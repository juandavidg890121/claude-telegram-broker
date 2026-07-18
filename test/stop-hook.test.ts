/**
 * The Stop hook, end to end: the real hook script, spawned the way Claude
 * Code spawns it, against a stand-in Telegram server.
 *
 * Spawned rather than imported, matching ask-hook.test.ts's own reasoning:
 * stdout/stderr discipline and real subprocess env resolution are properties
 * of the *process*, not testable by importing main().
 *
 * What this file actually exists to pin down: mirrorReply records a pong
 * (src/heartbeat.ts's PongStore) only on a REAL successful Telegram send —
 * not merely on having tried, and not when there was nothing to mirror.
 */
import assert from 'node:assert/strict';
import { describe, it, before, after, beforeEach } from 'node:test';
import { spawn } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { PongStore } from '../src/heartbeat.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const HOOK = join(root, 'scripts', 'mirror', 'stop-hook.ts');
// Same reasoning as ask-hook.test.ts: node_modules/.bin/tsx has no extension
// and isn't directly spawnable on Windows without a shell. Go straight at
// tsx's own CLI entrypoint through the current Node binary instead.
const TSX_CLI = join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs');

const SESSION = '11111111-2222-3333-4444-555555555555';
const CONVERSATION = '-1001234567890:42';

const sandbox = mkdtempSync(join(tmpdir(), 'broker-stophook-'));
const stateFile = join(sandbox, 'state.json');
const mirrorDir = join(sandbox, 'mirror');
const pongFile = join(sandbox, 'pong.json');

type Run = { stdout: string; stderr: string; code: number | null };

function runHook(payload: Record<string, unknown>, env: Record<string, string> = {}): Promise<Run> {
  const child = spawn(process.execPath, [TSX_CLI, HOOK], {
    env: {
      ...process.env,
      BROKER_STATE_FILE: stateFile,
      BROKER_MIRROR_DIR: mirrorDir,
      BROKER_PONG_FILE: pongFile,
      TELEGRAM_BOT_TOKEN: 'test-token',
      TELEGRAM_API_BASE: telegramUrl,
      ...env,
    },
  });
  child.stdin.end(JSON.stringify(payload));

  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => (stdout += chunk));
  child.stderr.on('data', (chunk) => (stderr += chunk));
  return new Promise((resolve) => child.on('close', (code) => resolve({ stdout, stderr, code })));
}

let telegramUrl = '';
let telegram: Server;
/** true: respond 200 like a real send. false: respond 500, so send() throws. */
let telegramShouldSucceed = true;

before(async () => {
  telegram = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      if (telegramShouldSucceed) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, result: { message_id: 1 } }));
      } else {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, description: 'simulated failure' }));
      }
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
  telegramShouldSucceed = true;
  rmSync(pongFile, { force: true });
  writeFileSync(
    stateFile,
    JSON.stringify([{ conversationId: CONVERSATION, sessionId: SESSION, cwd: '/tmp', title: 'demo', watch: true }]),
  );
});

describe('the Stop hook, pong recording', () => {
  it('records a pong after a real successful mirror', async () => {
    const run = await runHook({
      session_id: SESSION,
      last_assistant_message: 'hello from the session',
      stop_hook_active: true, // skip the /watch arm-instruction branch, irrelevant here
    });
    assert.equal(run.code, 0);
    assert.ok(new PongStore(pongFile).lastPongAt(SESSION) !== null, 'a successful send must record a pong');
  });

  it('does not record a pong when the send fails', async () => {
    telegramShouldSucceed = false;
    const run = await runHook({
      session_id: SESSION,
      last_assistant_message: 'hello from the session',
      stop_hook_active: true,
    });
    assert.equal(run.code, 0, 'a Telegram hiccup must never fail the hook itself');
    assert.equal(new PongStore(pongFile).lastPongAt(SESSION), null, 'a fully-failed send must not record a pong');
  });

  it('does not record a pong when there is no reply text to mirror', async () => {
    const run = await runHook({ session_id: SESSION, stop_hook_active: true });
    assert.equal(run.code, 0);
    assert.equal(new PongStore(pongFile).lastPongAt(SESSION), null);
  });

  it('does not record a pong for a session nobody is watching', async () => {
    writeFileSync(stateFile, JSON.stringify([]));
    const run = await runHook({
      session_id: SESSION,
      last_assistant_message: 'hello',
      stop_hook_active: true,
    });
    assert.equal(run.code, 0);
    assert.equal(new PongStore(pongFile).lastPongAt(SESSION), null);
  });
});

/**
 * Drives the SessionManager against a real Claude session with a fake frontend.
 * Verifies the three things the broker depends on: multi-turn memory in one
 * live session, the permission callback round-trip, and resume-after-stop.
 *
 *   npx tsx src/smoke.ts
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Registry } from './registry.js';
import { SessionManager } from './sessions.js';

const CONVO = 'test:1';
const out: string[] = [];
let permissionAsked = false;

const registry = new Registry(join(mkdtempSync(join(tmpdir(), 'broker-')), 'state.json'));
const sessions = new SessionManager({
  registry,
  emit: async (_convo, text) => {
    out.push(text);
    console.log(`  [claude] ${text.slice(0, 70)}`);
  },
  confirm: async (_convo, ask) => {
    permissionAsked = true;
    console.log(`  [permission] ${ask.toolName}: ${ask.preview} -> allow`);
    return true;
  },
});

const settle = (ms: number) => new Promise((r) => setTimeout(r, ms));

sessions.register(CONVO, process.cwd(), 'smoke');

console.log('1. first turn');
await sessions.send(CONVO, 'Reply with exactly the word: PINEAPPLE. Nothing else.');
await settle(25_000);

console.log('2. second turn (same live session — does it remember?)');
await sessions.send(CONVO, 'What word did you just say? Reply with only that word.');
await settle(25_000);

console.log('3. tool call — must be gated through the permission callback');
await sessions.send(CONVO, 'Run the bash command: echo hello-from-broker');
await settle(30_000);

const sessionId = registry.get(CONVO)?.sessionId;
console.log('4. stop, then resume from disk');
await sessions.stop(CONVO);
await sessions.send(CONVO, 'What word did you say at the start? Reply with only that word.');
await settle(30_000);
await sessions.stop(CONVO);

const remembered = out.slice(1).filter((t) => /PINEAPPLE/i.test(t)).length;
console.log('\n--- results ---');
console.log(`session id captured : ${sessionId ? `yes (${sessionId})` : 'NO'}`);
console.log(`multi-turn memory   : ${remembered >= 1 ? 'yes' : 'NO'}`);
console.log(`resume after stop   : ${remembered >= 2 ? 'yes' : 'NO'}`);
console.log(`permission gating   : ${permissionAsked ? 'yes' : 'NO — Bash ran unsupervised!'}`);
process.exit(permissionAsked && remembered >= 2 && sessionId ? 0 : 1);

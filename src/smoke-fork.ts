/**
 * Drives /fork's machinery against the real API. Verifies the three claims the
 * command makes to the user, none of which a filesystem test can check:
 * the fork carries the original's context, it gets a genuinely new id, and the
 * original is left untouched.
 *
 *   npx tsx src/smoke-fork.ts
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { forkSession, getSessionInfo, getSessionMessages } from '@anthropic-ai/claude-agent-sdk';
import { Registry } from './registry.js';
import { SessionManager } from './sessions.js';

const ORIGINAL = 'orig:1';
const FORKED = 'fork:1';
const out = new Map<string, string[]>();

const registry = new Registry(join(mkdtempSync(join(tmpdir(), 'broker-fork-')), 'state.json'));
const sessions = new SessionManager({
  registry,
  emit: async (convo, text) => {
    const seen = out.get(convo) ?? [];
    seen.push(text);
    out.set(convo, seen);
    console.log(`  [${convo}] ${text.slice(0, 70)}`);
  },
  confirm: async () => true,
});

const settle = (ms: number) => new Promise((r) => setTimeout(r, ms));

console.log('1. seed a session with a fact only it knows');
sessions.register(ORIGINAL, process.cwd(), 'original');
await sessions.send(ORIGINAL, 'Remember the codeword ARTICHOKE. Reply with just: OK');
await settle(25_000);
await sessions.stop(ORIGINAL);

const originalId = registry.get(ORIGINAL)?.sessionId;
if (!originalId) throw new Error('no session id captured — cannot fork');
const originalLength = (await getSessionMessages(originalId)).length;

console.log('2. resolve it by id, the way /fork does (no --path anywhere)');
const info = await getSessionInfo(originalId);
console.log(`   cwd from the session itself : ${info?.cwd ?? 'MISSING'}`);
console.log(`   summary                     : ${info?.summary ?? '(none)'}`);

console.log('3. fork it');
const forked = await forkSession(originalId, { title: 'smoke fork' });
console.log(`   ${originalId.slice(0, 8)} -> ${forked.sessionId.slice(0, 8)}`);

console.log('4. does the fork remember what only the original was told?');
const entry = sessions.register(FORKED, process.cwd(), 'forked');
entry.sessionId = forked.sessionId;
registry.put(entry);
await sessions.send(FORKED, 'What codeword did I ask you to remember? Reply with only that word.');
await settle(30_000);
await sessions.stop(FORKED);

console.log('5. and is the original still untouched?');
const originalAfter = await getSessionMessages(originalId);

const remembered = (out.get(FORKED) ?? []).some((t) => /ARTICHOKE/i.test(t));
const distinctId = forked.sessionId !== originalId;
const cwdResolved = Boolean(info?.cwd);
const originalIntact = originalAfter.length === originalLength;

console.log('\n--- results ---');
console.log(`cwd resolved from id  : ${cwdResolved ? 'yes' : 'NO'}`);
console.log(`fork got a new id     : ${distinctId ? 'yes' : 'NO'}`);
console.log(`fork carries context  : ${remembered ? 'yes' : 'NO'}`);
console.log(
  `original untouched    : ${originalIntact ? 'yes' : `NO — grew ${originalLength} -> ${originalAfter.length}`}`,
);
process.exit(cwdResolved && distinctId && remembered && originalIntact ? 0 : 1);

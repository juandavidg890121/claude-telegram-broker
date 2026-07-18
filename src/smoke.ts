/**
 * Drives the SessionManager against a real Claude session with a fake frontend.
 * Verifies the four things the broker depends on: multi-turn memory in one live
 * session, the permission callback round-trip, resume-after-stop, and answering
 * an AskUserQuestion.
 *
 * The last one earns a live test rather than a unit test because the property
 * belongs to the harness, not to this code: that filling `answers` in and
 * allowing the call resolves the tool *with that choice*, rather than telling
 * the model its question was interfered with. Nothing mockable can say whether
 * that contract still holds after an upgrade.
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
let questionAsked = false;

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
  ask: async (_convo, ask) => {
    questionAsked = true;
    // Always the *second* option, so a run that silently answered nothing —
    // and let the model pick its own favourite — cannot pass by coincidence.
    const answers = Object.fromEntries(
      ask.questions.map((question) => [question.question, question.options[1]?.label ?? question.options[0].label]),
    );
    console.log(`  [question] ${JSON.stringify(answers)}`);
    return answers;
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

console.log('4. AskUserQuestion — the answer must come back as the tool\'s result');
await sessions.send(
  CONVO,
  'Use the AskUserQuestion tool to ask whether I prefer the colour RED or BLUE. ' +
    'Then reply with exactly PICKED=<the colour I chose> and nothing else.',
);
await settle(35_000);
// The fake frontend always picks the second option, so the model can only say
// BLUE if the answer genuinely reached it.
const answerLanded = out.some((t) => /PICKED=BLUE/i.test(t));

const sessionId = registry.get(CONVO)?.sessionId;
console.log('5. stop, then resume from disk');
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
console.log(`question reached us : ${questionAsked ? 'yes' : 'NO — canUseTool never saw AskUserQuestion'}`);
console.log(`answer reached Claude: ${answerLanded ? 'yes' : 'NO — the choice did not become the tool result'}`);
process.exit(permissionAsked && questionAsked && answerLanded && remembered >= 2 && sessionId ? 0 : 1);

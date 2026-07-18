/**
 * Building the /watch hooks and folding them into a user's settings.json.
 *
 * The merge is the part with teeth: it edits a file the user owns and may share
 * with other tools. It must never drop what is already there, and must never
 * double a hook — a doubled Stop hook mirrors every reply to Telegram twice.
 */
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { ASK_HOOK_TIMEOUT_SEC, buildHookConfig, mergeHooks, tsxPath } from '../src/hooks-config.js';
import { ASK_TIMEOUT_SEC } from '../src/asks.js';

const root = '/opt/broker';

describe('buildHookConfig', () => {
  it('wires all three hooks with absolute paths from this checkout', () => {
    const config = buildHookConfig(root);
    assert.deepEqual(Object.keys(config), ['Stop', 'SessionStart', 'PreToolUse']);
    assert.match(config.Stop[0].hooks[0].command, /^\/opt\/broker\/node_modules\/\.bin\/tsx .*stop-hook\.ts$/);
  });

  it('scopes the AskUserQuestion hook with a matcher', () => {
    // Without it, a PreToolUse hook blocks on every tool call in the session.
    assert.equal(buildHookConfig(root).PreToolUse[0].matcher, 'AskUserQuestion');
  });

  it('gives the AskUserQuestion hook longer than it will wait', () => {
    // It blocks for the full ASK_TIMEOUT_SEC waiting for a tap. A `timeout` at
    // or below that has Claude Code kill it moments before it reports back,
    // turning the clean "nobody answered" path into a killed process every time.
    const entry = buildHookConfig(root).PreToolUse[0].hooks[0];
    assert.equal(entry.timeout, ASK_HOOK_TIMEOUT_SEC);
    assert.ok(ASK_HOOK_TIMEOUT_SEC > ASK_TIMEOUT_SEC, 'the hook must outlive its own wait');
  });

  it('points at the hook that answers, not the one that only notified', () => {
    assert.match(buildHookConfig(root).PreToolUse[0].hooks[0].command, /ask-user-question-hook\.ts$/);
  });

  it('converts a native Windows root into a command Git Bash can run', () => {
    // The failure this exists to catch: both callers derive root with
    // fileURLToPath + join, so on Windows it arrives as `C:\Users\...`. A
    // config built from that had backslashes in every command and Git Bash
    // resolved none of them. Passing the native form is what makes this a real
    // test — a POSIX root cannot tell a broken conversion from a working one.
    const config = buildHookConfig('C:\\Users\\John Doe\\broker');
    for (const command of [config.Stop[0].hooks[0].command, config.PreToolUse[0].hooks[0].command]) {
      assert.doesNotMatch(command, /\\/, 'no OS-native separators');
      assert.doesNotMatch(command, /%[0-9A-Fa-f]{2}/, 'no percent-encoding');
      assert.ok(command.startsWith(`'/c/Users/John Doe/broker/node_modules/.bin/tsx'`), 'MSYS form, and quoted: the path has a space');
    }
  });

  it('keeps the tsx path native, for the callers that stat it', () => {
    // setup.ts and print-hooks.ts both existsSync() this. Handing them the Git
    // Bash form instead would fail that check on Windows every time — which is
    // why the conversion cannot live any earlier than the command string.
    assert.equal(tsxPath('C:\\Users\\dev\\broker'), join('C:\\Users\\dev\\broker', 'node_modules', '.bin', 'tsx'));
  });

  it('gives the Telegram-sending hooks the .env, and SessionStart none', () => {
    const config = buildHookConfig(root);
    assert.match(config.Stop[0].hooks[0].command, /--env-file-if-exists/);
    assert.doesNotMatch(config.SessionStart[0].hooks[0].command, /--env-file-if-exists/);
  });
});

describe('mergeHooks', () => {
  it('adds all three hooks to an empty settings object', () => {
    const merged = mergeHooks({}, buildHookConfig(root));
    const hooks = merged.hooks as Record<string, unknown[]>;
    assert.deepEqual(Object.keys(hooks), ['Stop', 'SessionStart', 'PreToolUse']);
  });

  it('leaves unrelated settings untouched', () => {
    const merged = mergeHooks({ model: 'opus', permissions: { ask: ['Bash'] } }, buildHookConfig(root));
    assert.equal(merged.model, 'opus');
    assert.deepEqual(merged.permissions, { ask: ['Bash'] });
  });

  it('appends to an event another tool already uses, keeping theirs', () => {
    const theirs = { type: 'command' as const, command: '/some/other/tool.sh' };
    const merged = mergeHooks({ hooks: { Stop: [{ hooks: [theirs] }] } }, buildHookConfig(root));
    const stop = (merged.hooks as Record<string, Array<{ hooks: unknown[] }>>).Stop;
    assert.equal(stop.length, 2, 'their Stop hook plus ours');
    assert.deepEqual(stop[0].hooks[0], theirs, 'theirs is still first and unchanged');
  });

  it('is idempotent — running setup twice does not double the hooks', () => {
    const config = buildHookConfig(root);
    const once = mergeHooks({}, config);
    const twice = mergeHooks(once, config);
    assert.deepEqual(twice, once, 'a second merge is a no-op');
  });

  it('does not mutate the settings it was given', () => {
    const original = { hooks: { Stop: [] as unknown[] } };
    mergeHooks(original, buildHookConfig(root));
    assert.deepEqual(original.hooks.Stop, [], 'the caller keeps its backup intact');
  });
});

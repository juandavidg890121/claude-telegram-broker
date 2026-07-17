/**
 * Building the /watch hooks and folding them into a user's settings.json.
 *
 * The merge is the part with teeth: it edits a file the user owns and may share
 * with other tools. It must never drop what is already there, and must never
 * double a hook — a doubled Stop hook mirrors every reply to Telegram twice.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildHookConfig, mergeHooks } from '../src/hooks-config.js';

const root = '/opt/broker';

describe('buildHookConfig', () => {
  it('wires all three hooks with absolute paths from this checkout', () => {
    const config = buildHookConfig(root);
    assert.deepEqual(Object.keys(config), ['Stop', 'SessionStart', 'PreToolUse']);
    assert.match(config.Stop[0].hooks[0].command, /^\/opt\/broker\/node_modules\/\.bin\/tsx .*stop-hook\.ts$/);
  });

  it('scopes the AskUserQuestion hook with a matcher', () => {
    // Without it, a PreToolUse hook fires on every tool call in the session.
    assert.equal(buildHookConfig(root).PreToolUse[0].matcher, 'AskUserQuestion');
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

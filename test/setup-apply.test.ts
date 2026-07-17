/**
 * The non-interactive `--apply` path, exercised as a real process.
 *
 * This is what the /telegram-broker:setup skill uses in editors where the
 * interactive installer can't reach a terminal, so it's worth running end to
 * end: a plan in, the config written, the plan file (which held the token)
 * gone, and a bad plan refused before anything lands.
 *
 * `output: "export"` keeps these from touching the repo's own .env — apply
 * prints the exports instead — while HOME is redirected so the hook merge writes
 * to a throwaway settings.json, not the developer's.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, it } from 'node:test';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const script = join(root, 'scripts', 'setup.ts');

/** Run the installer in apply mode with an isolated HOME; return stdout + exit. */
function apply(plan: unknown): { code: number; out: string; planPath: string; home: string } {
  const dir = mkdtempSync(join(tmpdir(), 'apply-'));
  const home = mkdtempSync(join(tmpdir(), 'apply-home-'));
  const planPath = join(dir, 'plan.json');
  writeFileSync(planPath, JSON.stringify(plan));
  try {
    const out = execFileSync(process.execPath, ['--import', 'tsx', script, '--apply', planPath], {
      env: { ...process.env, HOME: home, USERPROFILE: home, BROKER_STATE_FILE: join(home, 'state.json') },
      encoding: 'utf8',
    });
    return { code: 0, out, planPath, home };
  } catch (error) {
    const e = error as { status?: number; stdout?: string; stderr?: string };
    return { code: e.status ?? 1, out: `${e.stdout ?? ''}${e.stderr ?? ''}`, planPath, home };
  }
}

const base = {
  token: '123456789:AAdummyTokenForTest_abcDEF',
  allowedUsers: ['111', '222'],
  groupId: '1001234567890',
  output: 'export' as const,
  installHooks: true,
};

describe('setup --apply', () => {
  it('writes the config and merges the hooks from a valid plan', () => {
    const { code, out, home } = apply(base);
    assert.equal(code, 0, out);

    // The exports carry the answers, with the group id's minus restored.
    assert.match(out, /export TELEGRAM_BOT_TOKEN='123456789:AAdummyTokenForTest_abcDEF'/);
    assert.match(out, /export TELEGRAM_ALLOWED_USERS='111,222'/);
    assert.match(out, /export TELEGRAM_GROUP_ID='-1001234567890'/);

    const settings = JSON.parse(readFileSync(join(home, '.claude', 'settings.json'), 'utf8'));
    assert.deepEqual(Object.keys(settings.hooks), ['Stop', 'SessionStart', 'PreToolUse']);
  });

  it('deletes the plan file, which held the token', () => {
    const { planPath } = apply(base);
    assert.equal(existsSync(planPath), false, 'the token must not be left on disk');
  });

  it('dedupes allowed users and normalises the group id', () => {
    const { out } = apply({ ...base, allowedUsers: ['111', '222', '111'], groupId: '-1009999' });
    assert.match(out, /TELEGRAM_ALLOWED_USERS='111,222'/);
    assert.match(out, /TELEGRAM_GROUP_ID='-1009999'/);
  });

  it('refuses a bad token before writing anything', () => {
    const { code, out } = apply({ ...base, token: 'not-a-token' });
    assert.notEqual(code, 0);
    assert.match(out, /bot token/);
  });

  it('refuses an empty allowlist', () => {
    const { code, out } = apply({ ...base, allowedUsers: [] });
    assert.notEqual(code, 0);
    assert.match(out, /at least one allowed user/);
  });

  it('refuses a working directory that does not exist', () => {
    const { code, out } = apply({ ...base, defaultCwd: '/definitely/not/here' });
    assert.notEqual(code, 0);
    assert.match(out, /not an existing directory/);
  });

  it('refuses an unknown whisper model without attempting a download', () => {
    // Caught by validateModelChoice before any network call.
    const { code, out } = apply({ ...base, whisper: { model: 'enormous', dir: tmpdir() } });
    assert.notEqual(code, 0);
    assert.match(out, /Unknown model/);
  });
});

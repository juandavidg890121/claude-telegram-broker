/**
 * The installer's decidable logic — where a wrong answer is silent.
 *
 * A malformed .env line could smuggle in a second variable; a group id missing
 * its minus sign fails only much later with a baffling "chat not found"; a
 * getUpdates payload has to yield the right id or the whole point (not making
 * the user hunt for it) is lost. None of that needs a terminal to check.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  MAX_TRIES,
  PERMISSION_MODES,
  WHISPER_MODELS,
  assertPlausibleModel,
  collectRequired,
  expandHome,
  formatSize,
  modelFilename,
  modelUrl,
  normalizeGroupId,
  parseGetMe,
  parseUpdates,
  renderEnv,
  renderExports,
  validateLanguage,
  validateModelChoice,
  validateModelId,
  validatePermissionMode,
  validateToken,
  validateUserId,
} from '../src/setup-core.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

describe('validateToken', () => {
  it('accepts a real-shaped token, trimmed', () => {
    assert.equal(validateToken('  123456789:AAHdqTcvC-abc_DEF  '), '123456789:AAHdqTcvC-abc_DEF');
  });

  it('rejects anything without the id:secret shape', () => {
    for (const bad of ['', 'not-a-token', '123456789', 'abc:def', '123 456:secret']) {
      assert.throws(() => validateToken(bad), /bot token/, `"${bad}" should be rejected`);
    }
  });
});

describe('validateUserId', () => {
  it('keeps the id as a string', () => {
    // Ids brush against 2^53; parsing to Number would eventually lose digits.
    assert.equal(validateUserId(' 7123456789 '), '7123456789');
    assert.equal(typeof validateUserId('1'), 'string');
  });

  it('rejects non-numeric ids', () => {
    assert.throws(() => validateUserId('@handle'), /user id/);
    assert.throws(() => validateUserId('-100'), /user id/);
  });
});

describe('normalizeGroupId', () => {
  it('restores a dropped leading minus', () => {
    // Copying "-1001234567890" without the minus is the classic mistake, and
    // its only symptom is a 400 much later.
    assert.equal(normalizeGroupId('1001234567890'), '-1001234567890');
  });

  it('leaves an already-negative id alone', () => {
    assert.equal(normalizeGroupId('-1001234567890'), '-1001234567890');
  });

  it('treats empty as "no group", not an error', () => {
    assert.equal(normalizeGroupId(''), '');
    assert.equal(normalizeGroupId('   '), '');
  });

  it('rejects a non-numeric group id', () => {
    assert.throws(() => normalizeGroupId('my group'), /group id/);
  });
});

describe('parseGetMe', () => {
  it('returns the bot identity on ok', () => {
    assert.deepEqual(parseGetMe({ ok: true, result: { id: 42, username: 'my_bot' } }), {
      id: 42,
      username: 'my_bot',
    });
  });

  it('surfaces the reason Telegram gave when it refuses', () => {
    assert.throws(() => parseGetMe({ ok: false, description: 'Unauthorized' }), /Unauthorized/);
  });

  it('does not crash on a shapeless response', () => {
    assert.throws(() => parseGetMe(undefined), /token/);
    assert.throws(() => parseGetMe({ ok: true, result: {} }), /token/);
  });
});

describe('parseUpdates', () => {
  it('reads a user id from a private message', () => {
    const { users, groups } = parseUpdates({
      result: [{ message: { from: { id: 555, username: 'ana' }, chat: { id: 555, type: 'private' } } }],
    });
    assert.deepEqual(users, [{ id: '555', name: 'ana' }]);
    assert.deepEqual(groups, []);
  });

  it('reads a group id from a group message, ignoring the sender as a user', () => {
    const { users, groups } = parseUpdates({
      result: [
        { message: { from: { id: 555 }, chat: { id: -100999, type: 'supergroup', title: 'Sessions' } } },
      ],
    });
    assert.deepEqual(groups, [{ id: '-100999', title: 'Sessions' }]);
    assert.deepEqual(users, [], 'a group message is not how you learn a user id');
  });

  it('falls back to first_name, then the id, when there is no username', () => {
    const [byName] = parseUpdates({
      result: [{ message: { from: { id: 1, first_name: 'Bo' }, chat: { id: 1, type: 'private' } } }],
    }).users;
    assert.equal(byName.name, 'Bo');

    const [byId] = parseUpdates({
      result: [{ message: { from: { id: 2 }, chat: { id: 2, type: 'private' } } }],
    }).users;
    assert.equal(byId.name, '2');
  });

  it('dedupes and keeps newest last', () => {
    // Two messages from the same chat are one chat; the caller takes the last.
    const { groups } = parseUpdates({
      result: [
        { message: { chat: { id: -100, type: 'group', title: 'Old name' } } },
        { message: { chat: { id: -100, type: 'group', title: 'New name' } } },
      ],
    });
    assert.deepEqual(groups, [{ id: '-100', title: 'New name' }]);
  });

  it('survives junk in the update list', () => {
    const { users, groups } = parseUpdates({ result: [null, {}, { message: {} }, 'nonsense'] });
    assert.deepEqual(users, []);
    assert.deepEqual(groups, []);
  });

  it('survives a payload with no result at all', () => {
    assert.deepEqual(parseUpdates({}), { users: [], groups: [] });
    assert.deepEqual(parseUpdates(undefined), { users: [], groups: [] });
  });
});

describe('renderEnv', () => {
  it('writes only the required keys when nothing optional is set', () => {
    const env = renderEnv({ token: 'T:123', allowedUsers: ['1', '2'] });
    assert.match(env, /^TELEGRAM_BOT_TOKEN=T:123$/m);
    assert.match(env, /^TELEGRAM_ALLOWED_USERS=1,2$/m);
    assert.doesNotMatch(env, /TELEGRAM_GROUP_ID/, 'no group means no group line, not an empty one');
    assert.doesNotMatch(env, /BROKER_/, 'unset optionals are absent, not commented-out clutter');
  });

  it('includes optionals only when set', () => {
    const env = renderEnv({
      token: 'T:1',
      allowedUsers: ['1'],
      groupId: '-100',
      model: 'claude-opus-4-8',
      whisperDir: '/opt/whisper',
    });
    assert.match(env, /^TELEGRAM_GROUP_ID=-100$/m);
    assert.match(env, /^BROKER_MODEL=claude-opus-4-8$/m);
    assert.match(env, /^BROKER_WHISPER_DIR=\/opt\/whisper$/m);
    assert.doesNotMatch(env, /BROKER_PERMISSION_MODE/, 'an untouched optional stays out');
  });

  it('neutralises a newline that would smuggle in a second variable', () => {
    // The token is pasted; a stray newline must not become a new .env line.
    const env = renderEnv({ token: 'T:1\nEVIL=x', allowedUsers: ['1'] });
    const tokenLines = env.split('\n').filter((l) => l.startsWith('TELEGRAM_BOT_TOKEN'));
    assert.equal(tokenLines.length, 1);
    assert.doesNotMatch(env, /^EVIL=/m, 'the injected line must not stand on its own');
  });

  it('quotes a value that contains spaces', () => {
    const env = renderEnv({ token: 'T:1', allowedUsers: ['1'], defaultCwd: '/home/a b/code' });
    assert.match(env, /^BROKER_DEFAULT_CWD="\/home\/a b\/code"$/m);
  });

  it('ends with a trailing newline', () => {
    assert.ok(renderEnv({ token: 'T:1', allowedUsers: ['1'] }).endsWith('\n'));
  });
});

describe('renderExports', () => {
  const answers = { token: 'T:1', allowedUsers: ['1', '2'], groupId: '-100', defaultCwd: '/home/a b/code' };

  it('uses each shell own syntax', () => {
    assert.match(renderExports(answers, 'posix'), /^export TELEGRAM_BOT_TOKEN='T:1'$/m);
    assert.match(renderExports(answers, 'powershell'), /^\$env:TELEGRAM_BOT_TOKEN = 'T:1'$/m);
    assert.match(renderExports(answers, 'cmd'), /^set "TELEGRAM_BOT_TOKEN=T:1"$/m);
  });

  it('describes the same variables as .env, in the same order', () => {
    // The two forms must not disagree about what the config is.
    const envKeys = renderEnv(answers).match(/^[A-Z_]+(?==)/gm);
    const exportKeys = renderExports(answers, 'posix').match(/(?<=export )[A-Z_]+/g);
    assert.deepEqual(exportKeys, envKeys);
  });

  it('quotes a value with spaces so the path survives', () => {
    assert.match(renderExports(answers, 'posix'), /^export BROKER_DEFAULT_CWD='\/home\/a b\/code'$/m);
    assert.match(renderExports(answers, 'powershell'), /^\$env:BROKER_DEFAULT_CWD = '\/home\/a b\/code'$/m);
    assert.match(renderExports(answers, 'cmd'), /^set "BROKER_DEFAULT_CWD=\/home\/a b\/code"$/m);
  });

  it('escapes each shell own quote or metacharacter', () => {
    const tricky = { token: "a'b", allowedUsers: ['1'] };
    assert.match(renderExports(tricky, 'posix'), /export TELEGRAM_BOT_TOKEN='a'\\''b'/);
    assert.match(renderExports(tricky, 'powershell'), /\$env:TELEGRAM_BOT_TOKEN = 'a''b'/);
    assert.match(renderExports({ token: 'a%b', allowedUsers: ['1'] }, 'cmd'), /set "TELEGRAM_BOT_TOKEN=a%%b"/);
  });
});

describe('validatePermissionMode', () => {
  it('accepts each real mode', () => {
    for (const mode of PERMISSION_MODES) assert.equal(validatePermissionMode(mode), mode);
  });

  it('rejects anything else with the list', () => {
    assert.throws(() => validatePermissionMode('yolo'), /default, acceptEdits/);
  });

  it('stays in step with the broker own PERMISSION_MODES', () => {
    // Read as text rather than imported: sessions.ts pulls in config.ts, which
    // throws at import without the broker's env. This guards the copy against
    // the original silently gaining or losing a mode.
    const source = readFileSync(fileURLToPath(new URL('../src/sessions.ts', import.meta.url)), 'utf8');
    const block = source.match(/PERMISSION_MODES[^=]*=\s*\[([^\]]*)\]/)?.[1] ?? '';
    const brokerModes = [...block.matchAll(/'([^']+)'/g)].map((m) => m[1]);
    assert.deepEqual([...PERMISSION_MODES], brokerModes);
  });
});

describe('validateModelId', () => {
  it('accepts a model id', () => {
    assert.equal(validateModelId(' claude-opus-4-8 '), 'claude-opus-4-8');
  });

  it('rejects a value with spaces — that is a sentence, not an id', () => {
    assert.throws(() => validateModelId('the best one'), /model id/);
  });
});

describe('validateLanguage', () => {
  it('accepts a two-letter code and auto', () => {
    assert.equal(validateLanguage('ES'), 'es');
    assert.equal(validateLanguage('auto'), 'auto');
  });

  it('rejects anything else', () => {
    assert.throws(() => validateLanguage('spanish'), /language/);
    assert.throws(() => validateLanguage('e'), /language/);
  });
});

describe('expandHome', () => {
  it('expands a leading ~ and nothing else', () => {
    assert.equal(expandHome('~/whisper', '/home/me'), '/home/me/whisper');
    assert.equal(expandHome('~', '/home/me'), '/home/me');
    assert.equal(expandHome('/opt/~/x', '/home/me'), '/opt/~/x', 'a ~ mid-path is a real directory name');
    assert.equal(expandHome('~user/x', '/home/me'), '~user/x', 'only bare ~ is home, not ~user');
  });
});

describe('whisper model catalog', () => {
  it('offers only multilingual models — never the .en traps', () => {
    for (const model of WHISPER_MODELS) assert.doesNotMatch(model.name, /\.en$/);
  });

  it('builds the HuggingFace resolve url', () => {
    assert.equal(modelUrl('base'), 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin');
    assert.equal(modelFilename('large-v3-turbo'), 'ggml-large-v3-turbo.bin');
  });
});

describe('validateModelChoice', () => {
  it('accepts a known model, however it was typed', () => {
    assert.equal(validateModelChoice('base').name, 'base');
    assert.equal(validateModelChoice('ggml-base.bin').name, 'base', 'the filename form resolves too');
  });

  it('sends an .en choice back to the multilingual one', () => {
    // The single most likely mistake, per the README, and its symptom is silent
    // gibberish — so it is refused by name, not downloaded.
    assert.throws(() => validateModelChoice('medium.en'), /English-only.*medium/);
  });

  it('rejects an unknown model instead of building a url to a 404', () => {
    assert.throws(() => validateModelChoice('enormous'), /Unknown model/);
  });
});

describe('assertPlausibleModel', () => {
  const ggmlByte = 0x67; // 'g' — a real ggml file starts with "ggml"

  it('passes a full-size binary download', () => {
    assert.doesNotThrow(() => assertPlausibleModel(ggmlByte, 150_000_000, 148_000_000));
  });

  it('rejects an HTML or JSON error page saved as .bin', () => {
    // A 404 or login redirect is a 200 with a web page body — the exact way a
    // wrong model name fails without this guard.
    assert.throws(() => assertPlausibleModel(0x3c /* < */, 150_000_000, 148_000_000), /web page/);
    assert.throws(() => assertPlausibleModel(0x7b /* { */, 150_000_000, 148_000_000), /web page/);
  });

  it('rejects a truncated download', () => {
    assert.throws(() => assertPlausibleModel(ggmlByte, 1_000, 148_000_000), /truncated or wrong/);
  });
});

describe('formatSize', () => {
  it('scales to KB, MB, GB', () => {
    assert.equal(formatSize(148_000_000), '148 MB');
    assert.equal(formatSize(1_620_000_000), '1.62 GB');
    assert.equal(formatSize(5_000), '5 KB');
  });
});

describe('collectRequired', () => {
  /** A reader that hands back a scripted list of answers, one per call. */
  const scripted = (answers: string[]) => {
    let i = 0;
    return () => Promise.resolve(answers[i++] ?? '');
  };

  it('returns the first valid answer', async () => {
    const value = await collectRequired(scripted(['123']), validateUserId);
    assert.equal(value, '123');
  });

  it('re-prompts past an empty answer rather than accepting it', async () => {
    // The whole point: Enter is not a way to skip a required field.
    const value = await collectRequired(scripted(['', '', '456']), validateUserId);
    assert.equal(value, '456');
  });

  it('rejects empty even when the validator itself would accept it', async () => {
    // The emptiness guard has to stand on its own: a free-text required field
    // (a whisper dir, say) has no format to reject a blank, so if collectRequired
    // didn't, Enter would sail straight through.
    const acceptAnything = (raw: string) => raw;
    await assert.rejects(() => collectRequired(scripted(['', '', '']), acceptAnything), /after 3 tries/);
    assert.equal(await collectRequired(scripted(['', 'ok']), acceptAnything), 'ok');
  });

  it('re-prompts past an invalid answer too', async () => {
    const value = await collectRequired(scripted(['@nope', '789']), validateUserId);
    assert.equal(value, '789');
  });

  it('fails after three empty answers instead of writing a blank', async () => {
    await assert.rejects(() => collectRequired(scripted(['', '', '']), validateUserId), /after 3 tries/);
  });

  it('stops at exactly MAX_TRIES', async () => {
    let reads = 0;
    const counting = () => {
      reads += 1;
      return Promise.resolve('');
    };
    await assert.rejects(() => collectRequired(counting, validateUserId));
    assert.equal(reads, MAX_TRIES, 'not one prompt more than the limit');
  });

  it('reports how many tries remain', async () => {
    const left: number[] = [];
    await collectRequired(scripted(['', '5']), validateUserId, (_m, triesLeft) => left.push(triesLeft));
    assert.deepEqual(left, [2], 'one empty answer, two tries left after it');
  });
});

/**
 * Which of the three audio states you land in, and what it tells you.
 *
 * The states carry the whole UX of an optional dependency: "off", "on but
 * broken, here's what's missing", and "ready". Collapsing the middle one into a
 * generic failure is how a typo in a path becomes an unfindable bug — so the
 * missing-pieces list is asserted, not just the state.
 */
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { after, beforeEach, describe, it } from 'node:test';
import { audioStatus, clean } from '../src/audio.js';

let dir: string;
const touch = (name: string, mode = 0o644) => {
  const path = join(dir, name);
  writeFileSync(path, '');
  chmodSync(path, mode);
  return path;
};

// ffmpeg is looked up on PATH as a fallback, so pin PATH to an empty directory:
// otherwise these tests pass or fail depending on whether the machine running
// them happens to have ffmpeg installed.
const emptyPath = mkdtempSync(join(tmpdir(), 'no-tools-'));
process.env.PATH = emptyPath;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'whisper-'));
});

describe('clean', () => {
  // Every string below came out of a real whisper-cli run, not from imagining
  // what one might print. "Empty" is the one thing whisper never says.

  it('treats the full stop whisper returns for silence as nothing', () => {
    // Measured: ggml-large-v3-turbo on two seconds of a sine wave prints ".".
    // The obvious `if (!text)` check passes that through, and Claude gets sent a
    // message containing a single full stop, which it dutifully tries to answer.
    assert.equal(clean('.\n'), '');
  });

  it('treats a bracketed non-speech annotation as nothing', () => {
    // Measured: ggml-base on the same audio prints "(crickets chirping)".
    assert.equal(clean(' (crickets chirping)\n'), '');
    assert.equal(clean('[BLANK_AUDIO]'), '');
    assert.equal(clean('[ Silence ]'), '');
    assert.equal(clean('(music)'), '');
  });

  it('keeps real speech, whitespace tidied', () => {
    assert.equal(clean('\n  Reinicia el broker, por favor.  \n'), 'Reinicia el broker, por favor.');
  });

  it('keeps speech that merely sits next to an annotation', () => {
    // Dropping the sentence because a noise was tagged mid-sentence would lose
    // the actual instruction.
    assert.equal(clean('[MUSIC] Deploy the branch, then tell me.'), 'Deploy the branch, then tell me.');
  });

  it('keeps text in any script, not just latin', () => {
    assert.equal(clean('¿Qué tal?'), '¿Qué tal?');
    assert.equal(clean('  测试  '), '测试');
    assert.equal(clean('42'), '42', 'a number is speech too');
  });

  it('is not fooled by punctuation-only output', () => {
    for (const junk of ['', '   ', '...', '. . .', '?!', '-', '\n\n']) {
      assert.equal(clean(junk), '', `${JSON.stringify(junk)} is not speech`);
    }
  });
});

describe('audioStatus', () => {
  it('is disabled when no directory is configured', () => {
    assert.deepEqual(audioStatus(undefined), { state: 'disabled' });
  });

  it('names the directory when it does not exist at all', () => {
    const status = audioStatus(join(dir, 'nope'));
    assert.equal(status.state, 'incomplete');
    // A typo'd path should say so, not report a missing binary.
    assert.match(status.state === 'incomplete' ? status.missing[0] : '', /directory itself/);
  });

  it('lists every missing piece at once, not just the first', () => {
    const status = audioStatus(dir);
    assert.equal(status.state, 'incomplete');
    if (status.state !== 'incomplete') return;
    assert.equal(status.missing.length, 3, 'binary, model and ffmpeg');
    assert.ok(status.missing.some((m) => m.includes('whisper.cpp binary')));
    assert.ok(status.missing.some((m) => m.includes('ggml-*.bin')));
    assert.ok(status.missing.some((m) => m.includes('ffmpeg')));
  });

  it('is ready once the binary, a model and ffmpeg are all present', () => {
    touch('whisper-cli', 0o755);
    touch('ggml-base.bin');
    touch('ffmpeg', 0o755);

    const status = audioStatus(dir);
    assert.equal(status.state, 'ready');
    if (status.state !== 'ready') return;
    assert.equal(status.tools.whisper, join(dir, 'whisper-cli'));
    assert.equal(status.tools.model, join(dir, 'ggml-base.bin'));
  });

  it('accepts the older `main` binary name', () => {
    // whisper.cpp renamed its CLI; a build from last year is still a valid one.
    touch('main', 0o755);
    touch('ggml-base.bin');
    touch('ffmpeg', 0o755);
    assert.equal(audioStatus(dir).state, 'ready');
  });

  it('finds ffmpeg on PATH rather than demanding a copy', () => {
    const binDir = mkdtempSync(join(tmpdir(), 'bin-'));
    writeFileSync(join(binDir, 'ffmpeg'), '');
    process.env.PATH = binDir;
    try {
      touch('whisper-cli', 0o755);
      touch('ggml-base.bin');
      const status = audioStatus(dir);
      assert.equal(status.state, 'ready');
      assert.equal(status.state === 'ready' && status.tools.ffmpeg, join(binDir, 'ffmpeg'));
    } finally {
      process.env.PATH = emptyPath;
    }
  });

  it('picks a model deterministically when several are present', () => {
    touch('whisper-cli', 0o755);
    touch('ffmpeg', 0o755);
    touch('ggml-small.bin');
    touch('ggml-large-v3.bin');
    // Sorted, so the same directory always yields the same model — an arbitrary
    // readdir order would silently change transcription quality between runs.
    assert.equal(
      audioStatus(dir).state === 'ready' && (audioStatus(dir) as any).tools.model,
      join(dir, 'ggml-large-v3.bin'),
    );
  });

  it('honours an explicitly configured model', () => {
    touch('whisper-cli', 0o755);
    touch('ffmpeg', 0o755);
    touch('ggml-large-v3.bin');
    touch('ggml-base.bin');
    const status = audioStatus(dir, 'ggml-base.bin');
    assert.equal(status.state === 'ready' && status.tools.model, join(dir, 'ggml-base.bin'));
  });

  it('reports the configured model by name when it is absent', () => {
    touch('whisper-cli', 0o755);
    touch('ffmpeg', 0o755);
    touch('ggml-base.bin'); // present, but not the one asked for
    const status = audioStatus(dir, 'ggml-large-v3.bin');
    assert.equal(status.state, 'incomplete');
    // Must not silently fall back to a different model than the one configured.
    assert.deepEqual(status.state === 'incomplete' && status.missing, [
      'the model file ggml-large-v3.bin',
    ]);
  });

  it('ignores files that are not models', () => {
    touch('whisper-cli', 0o755);
    touch('ffmpeg', 0o755);
    mkdirSync(join(dir, 'models'));
    touch('README.md');
    touch('ggml-base.bin.download'); // a half-finished download is not a model
    const status = audioStatus(dir);
    assert.equal(status.state, 'incomplete');
  });
});

/**
 * On Windows the lookup finds nothing at all unless it knows about `.exe` and
 * about `;` — both bugs report as "ffmpeg missing" on a machine where ffmpeg is
 * plainly installed, which is a long afternoon.
 *
 * The platform is faked because CI is Linux, and the alternative is shipping a
 * lookup for an OS nobody here can run — which is how it broke to begin with.
 * Only `process.platform` is fake: the directories, the PATH and every
 * existsSync call underneath are real.
 */
describe('on Windows', () => {
  const real = process.platform;
  const setPlatform = (value: string) =>
    Object.defineProperty(process, 'platform', { value, configurable: true });

  beforeEach(() => setPlatform('win32'));
  after(() => setPlatform(real));

  it('finds whisper-cli.exe, which an extensionless lookup walks straight past', () => {
    touch('whisper-cli.exe', 0o755);
    touch('ffmpeg.exe', 0o755);
    touch('ggml-base.bin');
    const status = audioStatus(dir);
    assert.equal(status.state, 'ready');
    assert.equal(status.state === 'ready' && status.tools.whisper, join(dir, 'whisper-cli.exe'));
  });

  it('prefers the .exe when a bare name sits next to it', () => {
    // MSYS-style installs ship both, and only one of them will execute.
    touch('whisper-cli', 0o755);
    touch('whisper-cli.exe', 0o755);
    touch('ffmpeg.exe', 0o755);
    touch('ggml-base.bin');
    const status = audioStatus(dir);
    assert.equal(status.state === 'ready' && status.tools.whisper, join(dir, 'whisper-cli.exe'));
  });

  it('finds ffmpeg.exe on PATH, past entries that do not have it', () => {
    touch('whisper-cli.exe', 0o755);
    touch('ggml-base.bin');
    const systemDir = mkdtempSync(join(tmpdir(), 'sys-'));
    writeFileSync(join(systemDir, 'ffmpeg.exe'), '');

    // `delimiter`, not a literal ';': node:path fixes it from the *real* OS at
    // load time, so a faked process.platform cannot move it — which is the whole
    // reason the code must use it too. The ';' half of the fix is therefore the
    // one thing here Linux cannot prove; what this pins is the other half, that
    // PATH entries are searched for the .exe name and not only the bare one.
    process.env.PATH = [emptyPath, systemDir].join(delimiter);
    try {
      const status = audioStatus(dir);
      assert.equal(status.state, 'ready');
      assert.equal(status.state === 'ready' && status.tools.ffmpeg, join(systemDir, 'ffmpeg.exe'));
    } finally {
      process.env.PATH = emptyPath;
    }
  });

  it('still names what is missing instead of guessing', () => {
    touch('whisper-cli.exe', 0o755);
    touch('ggml-base.bin');
    const status = audioStatus(dir);
    assert.equal(status.state, 'incomplete');
    assert.deepEqual(status.state === 'incomplete' && status.missing, [
      'ffmpeg (in that directory or on PATH)',
    ]);
  });
});

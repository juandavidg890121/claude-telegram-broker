import { execFile } from 'node:child_process';
import { existsSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

/**
 * Voice-note transcription with a local whisper.cpp.
 *
 * Local rather than hosted on purpose: PRIVACY.md promises this plugin runs
 * entirely on your machine, and lists the third parties it talks to as ones you
 * already chose. Posting your microphone to a speech API would add one you
 * didn't, for every voice note — including the ones describing private code.
 * whisper.cpp is a single binary, so it costs an install rather than that
 * promise.
 *
 * whisper.cpp and not faster-whisper/openai-whisper because those are Python
 * packages, and this project deliberately has no Python: the invocation is
 * `python`, which does not exist on Debian/Ubuntu without python-is-python3, and
 * a hook that can't start fails silently.
 */
export type AudioTools = { whisper: string; model: string; ffmpeg: string };

export type AudioStatus =
  | { state: 'disabled' }
  | { state: 'incomplete'; dir: string; missing: string[] }
  | { state: 'ready'; tools: AudioTools };

/** Newer whisper.cpp builds install `whisper-cli`; older ones called it `main`. */
const WHISPER_BINARIES = ['whisper-cli', 'main', 'whisper'];

function findIn(dir: string, names: readonly string[]): string | undefined {
  return names.map((name) => join(dir, name)).find((path) => existsSync(path));
}

function findModel(dir: string, configured?: string): string | undefined {
  if (configured) {
    const path = join(dir, configured);
    return existsSync(path) ? path : undefined;
  }
  try {
    const found = readdirSync(dir)
      .filter((n) => n.startsWith('ggml-') && n.endsWith('.bin'))
      .sort();
    return found.length ? join(dir, found[0]) : undefined;
  } catch {
    return undefined;
  }
}

/** ffmpeg is looked for in the whisper directory first, then on PATH — it is
 *  commonly already installed system-wide, and requiring a copy would be rude. */
function findFfmpeg(dir: string): string | undefined {
  const local = findIn(dir, ['ffmpeg']);
  if (local) return local;
  const fromPath = (process.env.PATH ?? '')
    .split(':')
    .filter(Boolean)
    .map((p) => join(p, 'ffmpeg'))
    .find((p) => existsSync(p));
  return fromPath;
}

/**
 * What audio can do right now, and if it can't, precisely what is missing.
 *
 * Three states, not two: "you never turned this on" and "you turned it on but
 * the model file isn't there" need different answers from the person holding the
 * phone. Collapsing them into "audio unavailable" is how a typo in a path
 * becomes a twenty-minute mystery.
 */
export function audioStatus(dir: string | undefined, configuredModel?: string): AudioStatus {
  if (!dir) return { state: 'disabled' };

  if (!existsSync(dir)) {
    return { state: 'incomplete', dir, missing: [`the directory itself (${dir})`] };
  }

  const whisper = findIn(dir, WHISPER_BINARIES);
  const model = findModel(dir, configuredModel);
  const ffmpeg = findFfmpeg(dir);

  const missing: string[] = [];
  if (!whisper) missing.push(`the whisper.cpp binary (${WHISPER_BINARIES.join(' / ')})`);
  if (!model) {
    missing.push(
      configuredModel
        ? `the model file ${configuredModel}`
        : 'a model file (ggml-*.bin)',
    );
  }
  if (!ffmpeg) missing.push('ffmpeg (in that directory or on PATH)');

  if (missing.length) return { state: 'incomplete', dir, missing };
  return { state: 'ready', tools: { whisper: whisper!, model: model!, ffmpeg: ffmpeg! } };
}

/**
 * Transcribe a Telegram voice note.
 *
 * Telegram sends OGG/Opus; whisper.cpp wants 16 kHz mono WAV, hence ffmpeg.
 * Both run through execFile with an argument array rather than a shell string —
 * the input path is derived from remote data, and a filename is not a place to
 * find out that a shell was involved.
 */
export async function transcribe(
  oggPath: string,
  tools: AudioTools,
  language = 'auto',
): Promise<string> {
  const wavPath = `${oggPath}.wav`;
  try {
    await run(tools.ffmpeg, ['-y', '-i', oggPath, '-ar', '16000', '-ac', '1', wavPath]);
    const { stdout } = await run(tools.whisper, [
      '-m', tools.model,
      '-f', wavPath,
      '-l', language,
      '-nt', // no timestamps — we want the sentence, not a subtitle track
      '-np', // no progress prints polluting stdout
    ]);
    return clean(stdout);
  } finally {
    // Best-effort: a leftover temp file must not fail the message.
    rmSync(wavPath, { force: true });
  }
}

/**
 * Whisper's answer for "there was no speech here" is not an empty string.
 *
 * Silence transcribes to `.` — measured, not guessed — and non-speech audio to
 * bracketed annotations like `[BLANK_AUDIO]` or `(music)`. An emptiness check
 * that only tests for `''` passes those straight through, and the caller sends
 * Claude a message containing a single full stop, which it then tries to answer.
 * Anything with no letter or digit in it is silence.
 */
export function clean(stdout: string): string {
  const text = stdout
    .replace(/\[[^\]]*\]|\([^)]*\)/g, ' ') // [BLANK_AUDIO], (music), [ Silence ]
    .replace(/\s+/g, ' ')
    .trim();
  return /\p{L}|\p{N}/u.test(text) ? text : '';
}

/**
 * Interactive first-run setup: ask for what the broker needs, discover what it
 * can, and write .env and the /watch hooks so nobody has to know the layout.
 *
 *   pnpm configure
 *
 * The manual half — creating the bot, turning privacy mode off, making the
 * forum group — happens inside Telegram and no script can do it, so this walks
 * you through those and then handles the rest: it validates the token against
 * Telegram, watches getUpdates to learn your user id and the group id (no
 * hunting through @userinfobot or log lines), writes .env with 0600 perms, and
 * folds the hooks into ~/.claude/settings.json with a backup.
 *
 * The token is read hidden and written straight to .env — it never lands in
 * this terminal's scrollback, and running this here rather than through Claude
 * keeps it out of any conversation transcript too.
 */
import {
  chmodSync,
  closeSync,
  copyFileSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { Readable } from 'node:stream';
import { ReadStream, WriteStream } from 'node:tty';
import { fileURLToPath } from 'node:url';
import { stdin, stdout } from 'node:process';
import { execFileSync } from 'node:child_process';
import { audioStatus } from '../src/audio.js';
import { buildHookConfig, mergeHooks, tsxPath } from '../src/hooks-config.js';
import {
  collectRequired,
  resolvePath,
  assertPlausibleModel,
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
  whisperBinaryAsset,
  whisperBinaryUrl,
  WHISPER_MODELS,
  WHISPER_RELEASE,
  type DiscoveredGroup,
  type DiscoveredUser,
  type SetupAnswers,
  type Shell,
} from '../src/setup-core.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const envPath = join(root, '.env');
const settingsPath = join(homedir(), '.claude', 'settings.json');

/**
 * Talk to the user's real terminal, even when our own stdin is a pipe.
 *
 * Run directly, stdin is a TTY and we use it. Launched by something else — the
 * /telegram-broker:setup skill runs us through Claude, whose stdin is not a
 * terminal — we open /dev/tty instead, the same trick ssh and sudo use to prompt
 * a human when their stdin is busy. Without this the prompts would go nowhere
 * and the first read would hit EOF. No /dev/tty (Windows, or truly headless)
 * means we fall back and the caller must run us in a real terminal.
 */
function openTerminal(): { input: NodeJS.ReadStream; output: NodeJS.WriteStream } {
  if (stdin.isTTY) return { input: stdin, output: stdout };
  if (process.platform !== 'win32') {
    try {
      return { input: new ReadStream(openSync('/dev/tty', 'r')), output: new WriteStream(openSync('/dev/tty', 'w')) };
    } catch {
      // No controlling terminal — fall through to the pipes we were given.
    }
  }
  return { input: stdin, output: stdout };
}

/**
 * `--apply <file>` runs non-interactively: read a plan of answers, do all the
 * writing, prompt for nothing. It exists for the /telegram-broker:setup skill,
 * which runs us through Claude in an environment with no usable terminal — the
 * interactive path can't get input there, so Claude collects the answers in the
 * conversation and hands them over as a file instead.
 */
const applyFile = ((): string | undefined => {
  const i = process.argv.indexOf('--apply');
  return i !== -1 ? process.argv[i + 1] : undefined;
})();

// Apply mode never prompts, so it must not grab /dev/tty — plain stdout is right.
const term = applyFile ? { input: stdin, output: stdout } : openTerminal();
const rl = createInterface({ input: term.input, output: term.output });
const say = (line = ''): void => void term.output.write(line + '\n');
const bold = (s: string): string => `\x1b[1m${s}\x1b[0m`;
const dim = (s: string): string => `\x1b[2m${s}\x1b[0m`;

async function ask(question: string, fallback = ''): Promise<string> {
  const answer = (await rl.question(`${question}${fallback ? dim(` [${fallback}]`) : ''} `)).trim();
  return answer || fallback;
}

/**
 * A required answer, with the give-up rule in collectRequired: Enter is not an
 * escape hatch, and MAX_TRIES empty-or-invalid answers stop the whole setup
 * rather than write half a config. `label` names the field in the messages;
 * `read` is passed in so the token can use the hidden reader.
 */
function required<T>(label: string, read: () => Promise<string>, validate: (raw: string) => Promise<T> | T): Promise<T> {
  return collectRequired(read, validate, (message, triesLeft) => {
    const left = triesLeft > 0 ? dim(` (${triesLeft} more)`) : '';
    say(`  ⚠️  ${label}: ${message}${left}`);
  });
}

/**
 * An optional answer that is still validated when given: Enter accepts the
 * default (or skips), anything else must pass `validate` or it re-asks. So
 * "optional" means "may be left blank", never "may be wrong" — a typo'd model
 * or permission mode is caught here, not at the broker's next start.
 */
async function optional<T>(
  question: string,
  validate: (raw: string) => T,
  fallback = '',
): Promise<T | undefined> {
  for (;;) {
    const raw = await ask(question, fallback);
    if (!raw) return undefined;
    try {
      return validate(raw);
    } catch (error) {
      say(`  ⚠️  ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

/** An existing directory: quotes stripped, ~ expanded. Must already be there —
 *  creating it silently would hide a typo in a working directory. */
function existingDir(raw: string): string {
  const path = resolvePath(raw, homedir());
  if (!statSync(path, { throwIfNoEntry: false })?.isDirectory()) {
    throw new Error(`"${raw}" is not an existing directory.`);
  }
  return path;
}

/** Create the directory if needed and prove we can actually write to it —
 *  a read-only or bad path should fail here, before a long download, not after. */
function writableDir(raw: string): string {
  const path = resolvePath(raw, homedir());
  mkdirSync(path, { recursive: true });
  const probe = join(path, `.setup-write-test-${process.pid}`);
  try {
    closeSync(openSync(probe, 'w'));
    rmSync(probe, { force: true });
  } catch {
    throw new Error(`Can't write to "${path}" — pick a directory you own.`);
  }
  return path;
}

/**
 * Stream `url` to `dest` with a progress line, into a `.part` file renamed only
 * on success so an interrupted download can't be mistaken for a finished one.
 * Returns the byte count for the caller to sanity-check.
 */
async function streamDownload(url: string, dest: string, sizeHint: number): Promise<number> {
  const response = await fetch(url);
  if (!response.ok || !response.body) throw new Error(`download failed: HTTP ${response.status}`);

  const total = Number(response.headers.get('content-length')) || sizeHint;
  const part = `${dest}.part`;
  const file = createWriteStream(part);
  let seen = 0;
  let lastShown = 0;

  try {
    for await (const chunk of Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0])) {
      file.write(chunk);
      seen += (chunk as Buffer).length;
      if (seen - lastShown > 2_000_000 || seen === total) {
        const pct = total ? ` (${Math.round((seen / total) * 100)}%)` : '';
        term.output.write(`\r    ↓ ${formatSize(seen)}${pct}   `);
        lastShown = seen;
      }
    }
    await new Promise<void>((resolve, reject) => file.end((err?: Error | null) => (err ? reject(err) : resolve())));
    term.output.write('\n');
    renameSync(part, dest);
    return seen;
  } catch (error) {
    file.destroy();
    rmSync(part, { force: true });
    throw error;
  }
}

/** Download a model, then refuse anything that isn't plausibly one — a 404 or a
 *  redirect to a web page arrives as HTML with a 200 and would fail much later. */
async function downloadModel(url: string, dest: string, expectedBytes: number): Promise<void> {
  const seen = await streamDownload(url, dest, expectedBytes);
  const head = Buffer.alloc(1);
  const fd = openSync(dest, 'r');
  try {
    readSync(fd, head, 0, 1, 0);
  } finally {
    closeSync(fd);
  }
  try {
    assertPlausibleModel(head[0], seen, expectedBytes);
  } catch (error) {
    rmSync(dest, { force: true }); // don't leave a bad model that reads as present
    throw error;
  }
}

/**
 * Download and unpack the prebuilt whisper.cpp binary for this platform, if one
 * exists, into `dir`. Returns whether it installed one.
 *
 * The whole archive is extracted, not just whisper-cli: it's a shared build, and
 * the binary's RUNPATH is `$ORIGIN`, so the .so/.dll siblings must sit next to
 * it — which is exactly where audioStatus and the broker then find it. macOS and
 * odd arches have no such asset and return false, leaving the caller to guide a
 * build.
 */
async function installWhisperBinary(dir: string): Promise<boolean> {
  const target = whisperBinaryAsset(process.platform, process.arch);
  if (!target) return false;

  const tag = await latestWhisperTag();
  const archive = join(dir, `.whisper-${target.asset}`);
  say(`    Downloading whisper-cli (${tag}, ${target.asset})…`);
  await streamDownload(whisperBinaryUrl(tag, target.asset), archive, 10_000_000);
  try {
    // tar handles both .tar.gz (GNU tar) and .zip (bsdtar, shipped on Windows 10+).
    // --strip-components=1 drops the archive's top-level folder.
    execFileSync('tar', ['-xf', archive, '-C', dir, '--strip-components=1'], { stdio: 'ignore' });
  } finally {
    rmSync(archive, { force: true });
  }
  return true;
}

/** The latest whisper.cpp release tag, or the pinned fallback if GitHub is
 *  unreachable — the asset names are stable, so only the tag can drift. */
async function latestWhisperTag(): Promise<string> {
  try {
    const response = await fetch('https://api.github.com/repos/ggml-org/whisper.cpp/releases/latest', {
      headers: { 'user-agent': 'telegram-broker-setup' },
    });
    const body = (await response.json()) as { tag_name?: string };
    return body.tag_name ?? WHISPER_RELEASE;
  } catch {
    return WHISPER_RELEASE;
  }
}

/**
 * The voice-note path: pick a model, get a writable directory, download the
 * model if it isn't already there, and report what's still missing — the binary
 * this can't reliably build, and ffmpeg — reusing the broker's own audioStatus
 * so setup and the running broker agree on "ready".
 */
async function setUpAudio(answers: SetupAnswers): Promise<void> {
  say('\n    Models — pick by where whisper runs, not by quality:');
  for (const m of WHISPER_MODELS) say(`      ${m.name}  ${dim(`${m.sizeMB} MB — ${m.when}`)}`);
  const model = (await optional('    Which model?', validateModelChoice, 'base')) ?? validateModelChoice('base');

  const dir = await required(
    'Whisper directory',
    () => ask('    Directory to install into', join(homedir(), '.claude', 'whisper')),
    writableDir,
  );
  answers.whisperDir = dir;

  const dest = join(dir, modelFilename(model.name));
  if (existsSync(dest) && statSync(dest).size > model.sizeMB * 700_000) {
    say(`    ${dim('✓')} ${modelFilename(model.name)} already there — skipping download`);
  } else {
    say(`    Downloading ${modelFilename(model.name)} ${dim(`(~${model.sizeMB} MB)`)}…`);
    await downloadModel(modelUrl(model.name), dest, model.sizeMB * 1_000_000);
    say(`    ${dim('✓')} model saved to ${dest}`);
  }

  // The binary. Prefer downloading the prebuilt one where it exists; only guide
  // a build where it doesn't (macOS) or if the download failed.
  if (audioStatus(dir).state !== 'ready' && whisperBinaryAsset(process.platform, process.arch)) {
    if (await yes('    Download the whisper-cli binary too?', true)) {
      try {
        await installWhisperBinary(dir);
        say(`    ${dim('✓')} whisper-cli installed`);
      } catch (error) {
        say(`    ⚠️  couldn't install the binary: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  answers.whisperLanguage = await optional('    Spoken language (two-letter code) or Enter to auto-detect', validateLanguage, 'auto').then(
    (lang) => (lang && lang !== 'auto' ? lang : undefined),
  );

  reportAudioReadiness(dir);
}

/** Say what's ready and what still needs a hand, reusing the broker's own check. */
function reportAudioReadiness(dir: string): void {
  const status = audioStatus(dir);
  if (status.state === 'ready') {
    say(`    ${dim('✓')} audio is ready — binary, model and ffmpeg all present.`);
    return;
  }
  if (status.state !== 'incomplete') return;

  const win = process.platform === 'win32';
  for (const missing of status.missing) {
    if (missing.includes('binary')) {
      const binary = win ? 'whisper-cli.exe' : 'whisper-cli';
      say(`    ${dim('!')} whisper.cpp binary (${binary}) not found in ${dir}.`);
      if (whisperBinaryAsset(process.platform, process.arch)) {
        // A prebuilt exists for this platform — re-run and accept the download.
        say('      Re-run setup and accept "Download the whisper-cli binary" to get it.');
      } else if (process.platform === 'darwin' && onPath('brew')) {
        say('      Install it with: ' + bold('brew install whisper-cpp') + `, then copy ${binary} here.`);
      } else {
        say('      Build it (needs cmake + a C++ compiler), see the README "Voice notes" section:');
        say(dim('        git clone --depth 1 https://github.com/ggml-org/whisper.cpp && cd whisper.cpp'));
        say(dim('        cmake -B build -DCMAKE_BUILD_TYPE=Release -DBUILD_SHARED_LIBS=OFF'));
        say(dim('        cmake --build build -j --config Release'));
        say(dim(`        cp build/bin/${binary} "${dir}/"`));
      }
    } else if (missing.includes('ffmpeg')) {
      // ffmpeg on PATH already satisfies audioStatus, so this only prints when
      // it's genuinely absent everywhere.
      const how = win ? 'winget install ffmpeg' : process.platform === 'darwin' ? 'brew install ffmpeg' : 'sudo apt install ffmpeg';
      say(`    ${dim('!')} ffmpeg not found in ${dir} or on PATH — install it: ${bold(how)}`);
    }
  }
  say(dim('    Voice notes turn on automatically once everything is in place.'));
}

/** Is a command on PATH? Used only to tailor a hint, so a false "no" is harmless. */
function onPath(cmd: string): boolean {
  try {
    execFileSync(process.platform === 'win32' ? 'where' : 'which', [cmd], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

async function yes(question: string, defaultYes = false): Promise<boolean> {
  const answer = (await rl.question(`${question} ${dim(defaultYes ? '[Y/n]' : '[y/N]')} `)).trim().toLowerCase();
  if (!answer) return defaultYes;
  return answer.startsWith('y') || answer === 's' || answer.startsWith('si');
}

/** Read a line without echoing it — for the token. Readline echoes typed
 *  characters by writing to its output, so muting that output hides them. */
async function secret(question: string): Promise<string> {
  const output = term.output as unknown as { write: (c: string) => boolean };
  output.write(question + ' ');
  const muted = { active: false };
  const original = output.write.bind(output);
  output.write = (chunk: string): boolean => (muted.active ? true : original(chunk));
  muted.active = true;
  try {
    const value = await rl.question('');
    return value.trim();
  } finally {
    muted.active = false;
    output.write = original;
    original('\n');
  }
}

async function api(token: string, method: string, params: Record<string, string> = {}): Promise<unknown> {
  const url = `https://api.telegram.org/bot${token}/${method}?${new URLSearchParams(params)}`;
  const response = await fetch(url);
  if (response.status === 409) {
    throw new Error('Telegram says another getUpdates is running — stop the broker first (it and this cannot poll at once).');
  }
  return response.json();
}

/**
 * Poll getUpdates until `pick` finds what we're waiting for, or the user gives
 * up and presses Enter to type it by hand. Returns [] on either giving up or
 * timing out; the caller falls back to a prompt. Consumes as it goes, so a
 * stale message from before setup started can't masquerade as the answer.
 *
 * The skip is a one-shot `line` listener, not a competing rl.question: a
 * pending question left listening after the poll wins would swallow the next
 * real prompt. The listener is always removed before returning.
 */
async function discover<T>(token: string, waitingFor: string, pick: (payload: unknown) => T[]): Promise<T[]> {
  say(dim(`  Waiting… (${waitingFor}) — or press Enter to type it in by hand.`));

  let skipped = false;
  const onLine = (): void => {
    skipped = true;
  };
  rl.once('line', onLine);

  try {
    let offset = 0;
    const deadline = Date.now() + 120_000;
    while (Date.now() < deadline && !skipped) {
      const payload = (await api(token, 'getUpdates', { offset: String(offset), timeout: '2' })) as {
        result?: Array<{ update_id: number }>;
      };
      for (const update of payload.result ?? []) offset = Math.max(offset, update.update_id + 1);
      const found = pick(payload);
      if (found.length) return found;
    }
    return [];
  } finally {
    rl.off('line', onLine);
  }
}

async function main(): Promise<void> {
  say(bold('\n  Telegram broker setup\n'));
  say('  This collects the config and sets up the /watch hooks. You choose at the');
  say('  end whether it lands in a .env file or as shell exports. A few steps happen');
  say('  inside Telegram and only you can do them — this walks you through those.\n');

  // 1. The bot ---------------------------------------------------------------
  say(bold('  1. The bot'));
  say('  Open @BotFather in Telegram, send /newbot, follow the prompts, and copy');
  say('  the token it gives you. Then turn privacy mode off so the bot can read');
  say('  group messages: /setprivacy → your bot → Disable.\n');

  const { token, botName } = await required(
    'A bot token',
    () => secret('  Paste the bot token:'),
    async (raw) => {
      const validated = validateToken(raw);
      const me = parseGetMe(await api(validated, 'getMe'));
      say(`  ${dim('✓')} token works — this is @${me.username}\n`);
      return { token: validated, botName: me.username };
    },
  );

  // 2. Your user id ----------------------------------------------------------
  say(bold('  2. You'));
  say('  Everyone allowed can approve tool calls — i.e. run commands on this');
  say(`  machine — so this is an allowlist. Open @${botName} and send it /start.`);
  const users = await discover<DiscoveredUser>(token, `DM @${botName}`, (p) => parseUpdates(p).users);
  let allowed: string[];
  if (users.length) {
    say(`  ${dim('✓')} that's you: ${users.map((u) => `${u.name} (${u.id})`).join(', ')}`);
    allowed = users.map((u) => u.id);
  } else {
    // Required: the broker refuses to start with an empty allowlist, so there
    // is no sensible empty answer to fall through to.
    allowed = [
      await required(
        'Your user id',
        () => ask('\n  Your numeric user id (from @userinfobot):'),
        (raw) => validateUserId(raw),
      ),
    ];
  }
  const extra = await ask('\n  Other user ids to allow, comma-separated, or Enter for none:');
  if (extra) allowed.push(...extra.split(',').map((s) => validateUserId(s)));
  allowed = [...new Set(allowed)];
  say(`  ${dim('✓')} allowed: ${allowed.join(', ')}\n`);

  // 3. The group -------------------------------------------------------------
  say(bold('  3. The group (for a topic per session)'));
  say('  /new opens one Telegram topic per Claude session, inside a forum-enabled');
  say('  group. Skip this and the broker still works in a single chat — one');
  say('  session for the whole conversation.\n');

  let groupId: string | undefined;
  if (await yes('  Set up the group now?', true)) {
    say('\n  Create a group, turn on Topics in its settings, add @' + botName + ' as an');
    say('  admin with "Manage Topics", then send any message in the group.');
    const groups = await discover<DiscoveredGroup>(token, 'post in the group', (p) => parseUpdates(p).groups);
    if (groups.length) {
      const chosen = groups[groups.length - 1];
      say(`  ${dim('✓')} group: ${chosen.title} (${chosen.id})`);
      groupId = chosen.id;
    } else {
      const typed = await ask('\n  Group id (starts with -100), or Enter to skip:');
      groupId = typed ? normalizeGroupId(typed) : undefined;
    }
    say('');
  }

  // 4. Defaults — always asked, Enter accepts the shown default ---------------
  const answers: SetupAnswers = { token, allowedUsers: allowed, groupId };
  say(bold('  4. Defaults') + dim(' — press Enter to accept each'));

  // Home is the default cwd the broker itself falls back to, so writing it would
  // just pin today's value; only a different directory is worth recording.
  const cwd = await optional('    Working directory /new starts sessions in', existingDir, homedir());
  if (cwd && cwd !== homedir()) answers.defaultCwd = cwd;
  say(dim(`      → ${answers.defaultCwd ?? `${homedir()} (the broker's default)`}`));

  // No default written: an empty BROKER_MODEL lets Claude Code pick, and pinning
  // a specific id here would silently freeze you to today's model.
  answers.model = await optional("    Model for new sessions, or Enter for Claude Code's default", validateModelId);
  say(dim(`      → ${answers.model ?? "Claude Code's default"}`));
  say('');

  // 5. Optional extras --------------------------------------------------------
  if (await yes(bold('  5. Configure extras') + ' (permission mode, voice notes)?', false)) {
    answers.permissionMode = await optional(
      '    Permission mode (default / acceptEdits / plan / dontAsk / bypassPermissions)',
      (raw) => {
        const mode = validatePermissionMode(raw);
        return mode === 'default' ? undefined : mode; // default is the default; no need to write it
      },
      'default',
    );

    if (await yes('    Enable voice notes (needs a local whisper.cpp)?', false)) {
      await setUpAudio(answers);
    }
    say('');
  }

  // 6. .env or exports -------------------------------------------------------
  say(bold('  6. Where should the configuration go?'));
  say('  1) a .env file next to the broker ' + dim('(recommended — the broker reads it automatically)'));
  say('  2) export commands you run in your shell ' + dim('(nothing is written to disk)'));
  const wroteEnv = (await ask('  Choose 1 or 2', '1')) !== '2';

  if (wroteEnv) {
    writeSecret(envPath, renderEnv(answers));
    say(`  ${dim('✓')} wrote ${envPath}${process.platform === 'win32' ? '' : dim(' (chmod 600 — it holds your token)')}`);
  } else {
    printExports(answers);
  }

  // 7. Hooks -----------------------------------------------------------------
  if (!existsSync(tsxPath(root))) {
    say(`\n  ${dim('!')} node_modules missing — run ${bold('pnpm install')} before starting the broker.`);
  }
  if (await yes('\n  Install the /watch hooks into ' + settingsPath + '?', true)) {
    installHooks();
    if (!wroteEnv) {
      say(dim('  Note: with no .env, these hooks need the variables exported in the'));
      say(dim('  environment Claude Code itself runs in — export them there too, or'));
      say(dim('  re-run setup and choose the .env file, which the hooks read directly.'));
    }
  } else {
    say('  Skipped. Run ' + bold('pnpm print-hooks') + ' later to add them by hand.');
  }

  // Done ---------------------------------------------------------------------
  say(bold('\n  Done.'));
  say('  Start the broker with ' + bold('/telegram-broker:start') + ' in Claude Code, or ' + bold('pnpm start') + ' here.');
  if (!groupId) say(dim('  (No group set — running in single-chat mode. Re-run setup to add one.)'));
  say('');
}

/** Atomic write, backup-first, 0600 — for the file that holds the token. */
function writeSecret(path: string, content: string): void {
  if (existsSync(path)) copyFileSync(path, `${path}.bak`);
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, content, { mode: 0o600 });
  renameSync(tmp, path);
  // POSIX only: on Windows chmod maps to the read-only bit and 0600 is
  // meaningless there, so skip it rather than pretend the file is locked down.
  if (process.platform !== 'win32') chmodSync(path, 0o600);
}

/**
 * Print the config as commands the user runs. Nothing is written, so the token
 * is visible in the terminal — that is the trade for choosing this over a file,
 * and the note says so.
 */
async function printExports(answers: SetupAnswers): Promise<void> {
  let shell: Shell = 'posix';
  if (process.platform === 'win32') {
    shell = (await ask('  Which shell — 1) PowerShell  2) cmd', '1')) === '2' ? 'cmd' : 'powershell';
  }
  say('\n  Run these in the shell where you start Claude Code / the broker:\n');
  for (const line of renderExports(answers, shell).split('\n')) say('    ' + line);
  say(dim('\n  These last for the current shell only. Add them to your shell profile'));
  say(dim('  to make them stick. The token is shown above — clear your scrollback'));
  say(dim('  if that matters to you.'));
}

function installHooks(): void {
  mkdirSync(dirname(settingsPath), { recursive: true });
  let settings: Record<string, unknown> = {};
  if (existsSync(settingsPath)) {
    try {
      settings = JSON.parse(readFileSync(settingsPath, 'utf8')) as Record<string, unknown>;
    } catch {
      say(`  ⚠️  ${settingsPath} isn't valid JSON — not touching it. Run pnpm print-hooks and merge by hand.`);
      return;
    }
    copyFileSync(settingsPath, `${settingsPath}.bak`);
  }

  const merged = mergeHooks(settings, buildHookConfig(root));
  const tmp = `${settingsPath}.tmp`;
  writeFileSync(tmp, JSON.stringify(merged, null, 2) + '\n');
  renameSync(tmp, settingsPath);
  say(`  ${dim('✓')} hooks installed ${existsSync(`${settingsPath}.bak`) ? dim('(backup at settings.json.bak)') : ''}`);
  say(dim('  Restart any open Claude session for them to load.'));
}

/** A plan handed to `--apply`: the same answers the interview collects, already
 *  decided. Every field is still validated before anything is written. */
type ApplyPlan = {
  token: string;
  allowedUsers: string[];
  groupId?: string;
  defaultCwd?: string;
  model?: string;
  permissionMode?: string;
  output?: 'env' | 'export';
  shell?: Shell;
  installHooks?: boolean;
  whisper?: { model?: string; dir: string; language?: string; installBinary?: boolean };
};

/**
 * Apply a plan without prompting, validating every field exactly as the
 * interactive path does — a plan Claude assembled from a chat is no more trusted
 * than something typed, so a bad model or a missing directory is still caught
 * here, not at the broker's next start.
 *
 * The plan file holds the token, so it is deleted the moment it's read.
 */
async function runApply(file: string): Promise<void> {
  const plan = JSON.parse(readFileSync(file, 'utf8')) as ApplyPlan;
  rmSync(file, { force: true }); // it carried the token; don't leave it lying around

  const users = (plan.allowedUsers ?? []).map((id) => validateUserId(String(id)));
  if (users.length === 0) throw new Error('The plan needs at least one allowed user id.');

  const answers: SetupAnswers = {
    token: validateToken(plan.token),
    allowedUsers: [...new Set(users)],
    groupId: plan.groupId ? normalizeGroupId(String(plan.groupId)) : undefined,
    defaultCwd: plan.defaultCwd ? existingDir(String(plan.defaultCwd)) : undefined,
    model: plan.model ? validateModelId(String(plan.model)) : undefined,
    permissionMode:
      plan.permissionMode && plan.permissionMode !== 'default' ? validatePermissionMode(String(plan.permissionMode)) : undefined,
  };

  if (plan.whisper?.dir) {
    const model = validateModelChoice(plan.whisper.model ?? 'base');
    const dir = writableDir(String(plan.whisper.dir));
    answers.whisperDir = dir;
    if (plan.whisper.language) {
      const lang = validateLanguage(plan.whisper.language);
      if (lang !== 'auto') answers.whisperLanguage = lang;
    }
    const dest = join(dir, modelFilename(model.name));
    if (!existsSync(dest) || statSync(dest).size < model.sizeMB * 700_000) {
      say(`Downloading ${modelFilename(model.name)} (~${model.sizeMB} MB)…`);
      await downloadModel(modelUrl(model.name), dest, model.sizeMB * 1_000_000);
    }
    // installBinary defaults on: a plan that asks for whisper wants it usable.
    if (plan.whisper.installBinary !== false && audioStatus(dir).state !== 'ready') {
      try {
        await installWhisperBinary(dir);
      } catch (error) {
        say(`⚠️  model downloaded, but the binary didn't: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    reportAudioReadiness(dir);
  }

  if (plan.output === 'export') {
    say(renderExports(answers, plan.shell ?? 'posix'));
  } else {
    writeSecret(envPath, renderEnv(answers));
    say(`✓ wrote ${envPath}`);
  }

  if (plan.installHooks !== false) installHooks();
  say('✓ setup applied.');
}

let finished = false;

// If stdin closes while a prompt is pending — EOF, piped input running out —
// the awaited question never settles and the process would hang, then exit on
// Node's "unsettled top-level await" path with a confusing code. Turn that into
// a clean, explained exit instead.
rl.once('close', () => {
  if (!finished && !applyFile) {
    say('\n  ⚠️  Input closed before setup finished. Run it again in a terminal.');
    process.exit(1);
  }
});

try {
  await (applyFile ? runApply(applyFile) : main());
  finished = true;
} catch (error) {
  finished = true;
  say(`\n  ⚠️  ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  rl.close();
}

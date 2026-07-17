/**
 * Interactive first-run setup: ask for what the broker needs, discover what it
 * can, and write .env and the /watch hooks so nobody has to know the layout.
 *
 *   pnpm setup
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
import { fileURLToPath } from 'node:url';
import { stdin, stdout } from 'node:process';
import { execFileSync } from 'node:child_process';
import { audioStatus } from '../src/audio.js';
import { buildHookConfig, mergeHooks, tsxPath } from '../src/hooks-config.js';
import {
  collectRequired,
  expandHome,
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
  WHISPER_MODELS,
  type DiscoveredGroup,
  type DiscoveredUser,
  type SetupAnswers,
  type Shell,
} from '../src/setup-core.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const envPath = join(root, '.env');
const settingsPath = join(homedir(), '.claude', 'settings.json');

const rl = createInterface({ input: stdin, output: stdout });
const say = (line = ''): void => console.log(line);
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

/** An existing directory, ~ expanded. Used for a working directory that must
 *  already be there — creating it silently would hide a typo. */
function existingDir(raw: string): string {
  const path = expandHome(raw.trim(), homedir());
  if (!statSync(path, { throwIfNoEntry: false })?.isDirectory()) {
    throw new Error(`"${raw}" is not an existing directory.`);
  }
  return path;
}

/** Create the directory if needed and prove we can actually write to it —
 *  a read-only or bad path should fail here, before a long download, not after. */
function writableDir(raw: string): string {
  const path = expandHome(raw.trim(), homedir());
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
 * Download a model to `dest`, streaming with a progress line, and refuse
 * anything that isn't plausibly a model.
 *
 * Downloads land in a `.part` file renamed only on success, so an interrupted
 * download can't be mistaken for a finished one. The size and first-bytes checks
 * are there because a 404 or a redirect to a login page comes back as HTML with
 * a 200, and saved as `ggml-base.bin` it would fail much later as "model unusable"
 * with nothing pointing at the actual cause.
 */
async function downloadModel(url: string, dest: string, expectedBytes: number): Promise<void> {
  const response = await fetch(url);
  if (!response.ok || !response.body) throw new Error(`download failed: HTTP ${response.status}`);

  const total = Number(response.headers.get('content-length')) || expectedBytes;
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
        stdout.write(`\r    ↓ ${formatSize(seen)}${pct}   `);
        lastShown = seen;
      }
    }
    await new Promise<void>((resolve, reject) => file.end((err?: Error | null) => (err ? reject(err) : resolve())));
    stdout.write('\n');

    const head = Buffer.alloc(1);
    const fd = openSync(part, 'r');
    try {
      readSync(fd, head, 0, 1, 0);
    } finally {
      closeSync(fd);
    }
    assertPlausibleModel(head[0], seen, expectedBytes);
    renameSync(part, dest);
  } catch (error) {
    file.destroy();
    rmSync(part, { force: true });
    throw error;
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

  for (const missing of status.missing) {
    if (missing.includes('binary')) {
      say(`    ${dim('!')} whisper.cpp binary not found in ${dir}.`);
      if (process.platform === 'darwin' && onPath('brew')) {
        say('      Install it with: ' + bold('brew install whisper-cpp') + ', then copy whisper-cli here.');
      } else {
        say('      Build it (needs cmake + a C++ compiler), see the README "Voice notes" section:');
        say(dim('        git clone --depth 1 https://github.com/ggml-org/whisper.cpp && cd whisper.cpp'));
        say(dim('        cmake -B build -DCMAKE_BUILD_TYPE=Release -DBUILD_SHARED_LIBS=OFF'));
        say(dim('        cmake --build build -j --config Release'));
        say(dim(`        cp build/bin/whisper-cli ${dir}/`));
      }
    } else if (missing.includes('ffmpeg')) {
      const how =
        process.platform === 'darwin' ? 'brew install ffmpeg' : process.platform === 'win32' ? 'winget install ffmpeg' : 'apt install ffmpeg';
      say(`    ${dim('!')} ffmpeg not found — install it: ${bold(how)}`);
    }
  }
  say(dim('    Voice notes turn on automatically once the binary is in place; nothing else to configure.'));
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

/** Read a line without echoing it — for the token. */
async function secret(question: string): Promise<string> {
  stdout.write(question + ' ');
  const muted = { active: false };
  const original = (stdout as unknown as { write: (c: string) => boolean }).write.bind(stdout);
  (stdout as unknown as { write: (c: string) => boolean }).write = (chunk: string): boolean =>
    muted.active ? true : original(chunk);
  muted.active = true;
  try {
    const value = await rl.question('');
    return value.trim();
  } finally {
    muted.active = false;
    (stdout as unknown as { write: (c: string) => boolean }).write = original;
    stdout.write('\n');
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

  // 4. Optional --------------------------------------------------------------
  const answers: SetupAnswers = { token, allowedUsers: allowed, groupId };
  if (await yes(bold('  4. Configure advanced options') + ' (model, permissions, voice notes)?', false)) {
    const cwd = await optional('\n  Default working directory for /new', existingDir, homedir());
    if (cwd && cwd !== homedir()) answers.defaultCwd = cwd;

    answers.model = await optional('  Model for new sessions, or Enter for the default:', validateModelId);

    answers.permissionMode = await optional(
      '  Permission mode (default / acceptEdits / plan / bypassPermissions)',
      (raw) => {
        const mode = validatePermissionMode(raw);
        return mode === 'default' ? undefined : mode; // default is the default; no need to write it
      },
      'default',
    );

    if (await yes('  Enable voice notes (needs a local whisper.cpp)?', false)) {
      await setUpAudio(answers);
    }
    say('');
  }

  // 5. .env or exports -------------------------------------------------------
  say(bold('  Where should the configuration go?'));
  say('  1) a .env file next to the broker ' + dim('(recommended — the broker reads it automatically)'));
  say('  2) export commands you run in your shell ' + dim('(nothing is written to disk)'));
  const wroteEnv = (await ask('  Choose 1 or 2', '1')) !== '2';

  if (wroteEnv) {
    writeSecret(envPath, renderEnv(answers));
    say(`  ${dim('✓')} wrote ${envPath}${process.platform === 'win32' ? '' : dim(' (chmod 600 — it holds your token)')}`);
  } else {
    printExports(answers);
  }

  // 6. Hooks -----------------------------------------------------------------
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

let finished = false;

// If stdin closes while a prompt is pending — EOF, piped input running out —
// the awaited question never settles and the process would hang, then exit on
// Node's "unsettled top-level await" path with a confusing code. Turn that into
// a clean, explained exit instead.
rl.once('close', () => {
  if (!finished) {
    say('\n  ⚠️  Input closed before setup finished. Run it again in a terminal.');
    process.exit(1);
  }
});

try {
  await main();
  finished = true;
} catch (error) {
  finished = true;
  say(`\n  ⚠️  ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  rl.close();
}

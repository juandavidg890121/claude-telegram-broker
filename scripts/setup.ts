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
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { stdin, stdout } from 'node:process';
import { buildHookConfig, mergeHooks, tsxPath } from '../src/hooks-config.js';
import {
  collectRequired,
  normalizeGroupId,
  parseGetMe,
  parseUpdates,
  renderEnv,
  renderExports,
  validateToken,
  validateUserId,
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
    const cwd = await ask('\n  Default working directory for /new', homedir());
    if (cwd !== homedir()) answers.defaultCwd = cwd;

    const model = await ask('  Model for new sessions, or Enter for the default:');
    if (model) answers.model = model;

    const mode = await ask('  Permission mode (default / acceptEdits / plan / bypassPermissions)', 'default');
    if (mode !== 'default') answers.permissionMode = mode;

    if (await yes('  Enable voice notes (needs a local whisper.cpp)?', false)) {
      answers.whisperDir = await ask('    Directory holding whisper-cli and a ggml-*.bin model:');
      const lang = await ask('    Spoken language, or Enter to auto-detect', 'auto');
      if (lang !== 'auto') answers.whisperLanguage = lang;
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

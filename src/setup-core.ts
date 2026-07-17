/**
 * The decidable half of the interactive installer, kept out of the readline
 * script so it can be tested without a terminal or a live bot.
 *
 * scripts/setup.ts owns everything that needs a human or the network — prompts,
 * hidden input, polling Telegram. This owns everything with a right answer:
 * what a valid token looks like, which id a getUpdates payload is offering, and
 * exactly what text lands in .env. Those are where a mistake is silent and
 * costly, so those are what the tests pin.
 */

/** A bot token is `<digits>:<url-safe base64>`; BotFather never varies it. */
const TOKEN = /^\d+:[A-Za-z0-9_-]+$/;

export function validateToken(raw: string): string {
  const token = raw.trim();
  if (!TOKEN.test(token)) {
    throw new Error('That does not look like a bot token. It should read like 123456789:AA... — copy it from @BotFather.');
  }
  return token;
}

/**
 * A numeric Telegram user id. Kept as a string: it is an identifier, never a
 * number to do arithmetic on, and ids already brush against 2^53 where Number
 * starts losing digits.
 */
export function validateUserId(raw: string): string {
  const id = raw.trim();
  if (!/^\d+$/.test(id)) throw new Error(`"${raw}" is not a user id — it should be digits only, e.g. 123456789.`);
  return id;
}

/**
 * A supergroup id, with the leading '-' restored if it was dropped.
 *
 * Copying the id without its minus sign yields a baffling `400: chat not found`
 * later, so fix it here — the same normalization config.ts does, duplicated
 * because config.ts throws at import without the broker's full env and the
 * installer is what runs *before* that env exists.
 */
export function normalizeGroupId(raw: string): string {
  const id = raw.trim();
  if (id === '') return '';
  if (!/^-?\d+$/.test(id)) throw new Error(`"${raw}" is not a group id — it should be digits, usually starting with -100.`);
  return id.startsWith('-') ? id : `-${id}`;
}

export type BotIdentity = { id: number; username: string };

/** Read getMe's answer, or explain why the token was refused. */
export function parseGetMe(payload: unknown): BotIdentity {
  const body = payload as { ok?: boolean; result?: { id?: number; username?: string }; description?: string };
  if (!body?.ok || !body.result?.username) {
    throw new Error(body?.description ?? 'Telegram rejected the token. Check you copied all of it from @BotFather.');
  }
  return { id: body.result.id ?? 0, username: body.result.username };
}

type Update = {
  message?: {
    from?: { id?: number; username?: string; first_name?: string };
    chat?: { id?: number; type?: string; title?: string };
  };
};

export type DiscoveredUser = { id: string; name: string };
export type DiscoveredGroup = { id: string; title: string };

/**
 * Pull the ids a getUpdates payload is offering, newest last so a caller taking
 * the last of each gets the most recent message.
 *
 * A private message reveals the sender's user id; a group or supergroup message
 * reveals the group id. Split so the installer can wait for the right kind: "DM
 * the bot" for yours, "post in the group" for the group's. Deduplicated, since
 * two messages from the same chat should not look like two chats.
 */
export function parseUpdates(payload: unknown): { users: DiscoveredUser[]; groups: DiscoveredGroup[] } {
  const updates = ((payload as { result?: Update[] })?.result ?? []).filter(
    (u): u is Update => typeof u === 'object' && u !== null,
  );

  const users = new Map<string, DiscoveredUser>();
  const groups = new Map<string, DiscoveredGroup>();

  for (const { message } of updates) {
    const chat = message?.chat;
    if (!chat || chat.id === undefined) continue;

    if (chat.type === 'private' && message?.from?.id !== undefined) {
      const id = String(message.from.id);
      users.set(id, { id, name: message.from.username ?? message.from.first_name ?? id });
    } else if (chat.type === 'group' || chat.type === 'supergroup') {
      const id = String(chat.id);
      groups.set(id, { id, title: chat.title ?? id });
    }
  }

  return { users: [...users.values()], groups: [...groups.values()] };
}

export type SetupAnswers = {
  token: string;
  allowedUsers: string[];
  groupId?: string;
  defaultCwd?: string;
  model?: string;
  permissionMode?: string;
  askTools?: string;
  whisperDir?: string;
  whisperModel?: string;
  whisperLanguage?: string;
};

/**
 * The KEY=value pairs a set of answers produces, required first.
 *
 * One list, so `.env` and every shell's `export` form describe the same
 * environment — a variable that reached the file but not the exports, or vice
 * versa, is exactly the kind of silent half-configuration this installer
 * exists to remove. A newline is stripped here, at the source, so no rendering
 * of it can smuggle in a second variable no matter the target syntax.
 */
export function configPairs(answers: SetupAnswers): Array<[string, string]> {
  const clean = (raw: string): string => raw.replace(/[\r\n]+/g, ' ').trim();
  const pairs: Array<[string, string]> = [
    ['TELEGRAM_BOT_TOKEN', answers.token],
    ['TELEGRAM_ALLOWED_USERS', answers.allowedUsers.join(',')],
  ];
  if (answers.groupId) pairs.push(['TELEGRAM_GROUP_ID', answers.groupId]);

  const optional: Array<[string, string | undefined]> = [
    ['BROKER_DEFAULT_CWD', answers.defaultCwd],
    ['BROKER_MODEL', answers.model],
    ['BROKER_PERMISSION_MODE', answers.permissionMode],
    ['BROKER_ASK_TOOLS', answers.askTools],
    ['BROKER_WHISPER_DIR', answers.whisperDir],
    ['BROKER_WHISPER_MODEL', answers.whisperModel],
    ['BROKER_WHISPER_LANGUAGE', answers.whisperLanguage],
  ];
  for (const [key, value] of optional) if (value) pairs.push([key, value]);

  return pairs.map(([key, value]) => [key, clean(value)]);
}

/**
 * A .env value, quoted for Node's --env-file parser.
 *
 * The Windows trap: that parser expands `\n`, `\t` and friends inside *double*
 * quotes, so a path like `C:\new folder\temp` written `"C:\new folder\temp"`
 * comes back with a real newline in it — a corruption that only bites Windows
 * users, and only for folders whose name starts with one of those letters.
 * Single-quoted values are taken literally, backslashes and all, so a value
 * that needs quoting is single-quoted whenever it can be (i.e. contains no
 * single quote of its own). The rare value with a `'` in it — a POSIX path like
 * /home/o'brien — falls back to double quotes with backslash and quote escaped,
 * where the lack of a backslash makes the expansion moot.
 */
function envValue(value: string): string {
  if (value === '') return "''";
  if (!/[\s#"'\\]/.test(value)) return value;
  if (!value.includes("'")) return `'${value}'`;
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/**
 * The exact text written to .env — only the keys the user actually set. An
 * installer that writes every optional key commented-out is just
 * .env.example, and the point was not to hand them that.
 */
export function renderEnv(answers: SetupAnswers): string {
  const [required, ...optional] = groupRequired(configPairs(answers));
  const lines = [
    '# Written by the telegram-broker setup. Re-run it to regenerate, or edit by hand.',
    '# See .env.example for every option and what it does.',
    '',
    ...required.map(([k, v]) => `${k}=${envValue(v)}`),
  ];
  if (optional.length) {
    lines.push('', ...optional.flat().map(([k, v]) => `${k}=${envValue(v)}`));
  }
  return lines.join('\n') + '\n';
}

/**
 * Permission modes the broker accepts, mirrored from sessions.ts's
 * PERMISSION_MODES — which can't be imported here because it pulls in config.ts,
 * and config.ts throws at import without the broker's own env, which is exactly
 * what setup runs *before* exists. A test guards the two lists against drift.
 */
export const PERMISSION_MODES = ['default', 'acceptEdits', 'plan', 'dontAsk', 'bypassPermissions'] as const;

export function validatePermissionMode(raw: string): string {
  const mode = raw.trim();
  if (!(PERMISSION_MODES as readonly string[]).includes(mode)) {
    throw new Error(`"${raw}" is not a permission mode. Pick one of: ${PERMISSION_MODES.join(', ')}.`);
  }
  return mode;
}

/** A Claude model id: no spaces, and not an accidental sentence. */
export function validateModelId(raw: string): string {
  const model = raw.trim();
  if (/\s/.test(model)) throw new Error(`"${raw}" doesn't look like a model id — those have no spaces, e.g. claude-opus-4-8.`);
  return model;
}

/** A whisper language: the two-letter code, or 'auto' to detect per message. */
export function validateLanguage(raw: string): string {
  const lang = raw.trim().toLowerCase();
  if (lang !== 'auto' && !/^[a-z]{2}$/.test(lang)) {
    throw new Error(`"${raw}" is not a language — use a two-letter code like es or en, or auto.`);
  }
  return lang;
}

/**
 * Strip one matched pair of surrounding quotes, if present.
 *
 * Windows Explorer's "Copy as path" wraps the path in double quotes, and people
 * paste paths that way out of habit, so `"C:\Users\me"` and `'…'` must mean the
 * same directory as the bare form. Only a *matched* leading+trailing pair is
 * removed, so a lone quote inside a name survives.
 */
export function stripSurroundingQuotes(raw: string): string {
  const trimmed = raw.trim();
  const first = trimmed[0];
  if ((first === '"' || first === "'") && trimmed.at(-1) === first && trimmed.length >= 2) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

/**
 * A filesystem path the user typed: quotes stripped, ~ expanded. The one funnel
 * every path input goes through, so pasted-with-quotes and typed-bare land in
 * the same place on every OS.
 */
export function resolvePath(raw: string, home: string): string {
  return expandHome(stripSurroundingQuotes(raw), home);
}

/** Expand a leading ~ to the home directory; leave every other path untouched. */
export function expandHome(path: string, home: string): string {
  return path.replace(/^~(?=$|[/\\])/, home);
}

export type WhisperModel = { name: string; sizeMB: number; when: string };

/**
 * The models worth offering, from the README's table. Multilingual only: the
 * `.en` variants are byte-for-byte the same size, trivial to pick by mistake
 * while scanning sizes, and mishear every non-English word with no error — so
 * they are simply not on the menu.
 */
export const WHISPER_MODELS: readonly WhisperModel[] = [
  { name: 'base', sizeMB: 148, when: 'CPU — start here' },
  { name: 'small', sizeMB: 488, when: 'CPU, if base mishears you' },
  { name: 'large-v3-turbo', sizeMB: 1620, when: 'GPU builds' },
  { name: 'large-v3', sizeMB: 3100, when: 'GPU, and only for translate mode' },
];

export const modelFilename = (name: string): string => `ggml-${name}.bin`;

/**
 * whisper.cpp ships prebuilt CLI binaries for some platforms, which beats
 * asking a novice to install cmake and compile. The Linux and Windows archives
 * carry whisper-cli next to its shared libs, and the binary's RUNPATH is
 * `$ORIGIN`, so it finds them in its own directory — extracting the whole
 * archive into the whisper dir just works. macOS has no such CLI asset (only an
 * xcframework for building apps), so it still falls back to brew or a build.
 *
 * Used if the release ever moves; the asset names have been stable across
 * releases, so only the tag changes.
 */
export const WHISPER_RELEASE = 'v1.9.1';

export type WhisperAsset = { asset: string; archive: 'tar.gz' | 'zip' };

export function whisperBinaryAsset(platform: NodeJS.Platform, arch: string): WhisperAsset | undefined {
  if (platform === 'linux' && arch === 'x64') return { asset: 'whisper-bin-ubuntu-x64.tar.gz', archive: 'tar.gz' };
  if (platform === 'linux' && arch === 'arm64') return { asset: 'whisper-bin-ubuntu-arm64.tar.gz', archive: 'tar.gz' };
  if (platform === 'win32' && arch === 'x64') return { asset: 'whisper-bin-x64.zip', archive: 'zip' };
  return undefined; // macOS, 32-bit Windows, anything else → build/brew
}

export const whisperBinaryUrl = (tag: string, asset: string): string =>
  `https://github.com/ggml-org/whisper.cpp/releases/download/${tag}/${asset}`;

/** Where the README says the models live — HuggingFace, the resolve (raw) path. */
export const modelUrl = (name: string): string =>
  `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/${modelFilename(name)}`;

/**
 * Resolve a model the user named to one we know how to fetch. Rejects the `.en`
 * models by name — someone who types one meant the multilingual one — and
 * anything not in the catalog, rather than build a URL to a 404.
 */
export function validateModelChoice(raw: string): WhisperModel {
  const name = raw.trim().replace(/^ggml-/, '').replace(/\.bin$/, '');
  if (name.endsWith('.en')) {
    throw new Error(`${name} is English-only and mishears everything else — use ${name.replace(/\.en$/, '')}.`);
  }
  const model = WHISPER_MODELS.find((m) => m.name === name);
  if (!model) throw new Error(`Unknown model "${raw}". Choose one of: ${WHISPER_MODELS.map((m) => m.name).join(', ')}.`);
  return model;
}

/**
 * Reject a finished download that isn't plausibly a model.
 *
 * A 404 or a redirect to a login page comes back as HTML or JSON with a 200,
 * and saved as ggml-base.bin it fails much later as "model unusable" with
 * nothing naming the real cause. `firstByte` catches the web page (`<` or `{`);
 * `seen` vs `expected` catches a truncated or wrong-file download. Kept pure so
 * the check that matters most is tested without pulling a model over the wire.
 */
export function assertPlausibleModel(firstByte: number, seen: number, expected: number): void {
  if (seen < expected * 0.7) {
    throw new Error(`only got ${formatSize(seen)} of an expected ~${formatSize(expected)} — the download looks truncated or wrong.`);
  }
  if (firstByte === 0x3c || firstByte === 0x7b) {
    throw new Error('the download was a web page, not a model — check the model name and your connection.');
  }
}

/** A byte count as MB/GB, for download sizes and progress. */
export function formatSize(bytes: number): string {
  if (bytes >= 1_000_000_000) return `${(bytes / 1_000_000_000).toFixed(2)} GB`;
  if (bytes >= 1_000_000) return `${Math.round(bytes / 1_000_000)} MB`;
  return `${Math.round(bytes / 1_000)} KB`;
}

export const MAX_TRIES = 3;

/**
 * The give-up rule for a required answer, kept here so it can be tested without
 * a terminal: read up to MAX_TRIES times, return the first non-empty value that
 * validates, and throw once the tries run out.
 *
 * The point is that a required field cannot be skipped by pressing Enter past
 * it — an empty answer is a failed try, not an accepted blank. The reader and
 * validator are injected so the real installer can wire in hidden input and
 * live API checks, and a test can wire in a scripted list of answers.
 */
export async function collectRequired<T>(
  read: () => Promise<string>,
  validate: (raw: string) => Promise<T> | T,
  onFailure: (message: string, triesLeft: number) => void = () => {},
): Promise<T> {
  for (let attempt = 1; attempt <= MAX_TRIES; attempt++) {
    const triesLeft = MAX_TRIES - attempt;
    const raw = (await read()).trim();
    if (!raw) {
      onFailure('required — it cannot be left blank', triesLeft);
      continue;
    }
    try {
      return await validate(raw);
    } catch (error) {
      onFailure(error instanceof Error ? error.message : String(error), triesLeft);
    }
  }
  throw new Error(`Not provided after ${MAX_TRIES} tries — setup stopped. Run it again when you have it.`);
}

export type Shell = 'posix' | 'powershell' | 'cmd';

/**
 * The variables as commands the user runs themselves, for whoever would rather
 * export than keep a file. Session-scoped, like `.env` and like `export`
 * itself: the note the installer prints says how to persist them.
 *
 * Three shells because the syntax genuinely differs — and handing a Windows
 * user a bash line is the same dead end as the placeholder paths this whole
 * flow replaced. Quoting keeps spaces and each shell's own metacharacters as
 * data: `'\''` for sh, doubled `''` for PowerShell, `%%` for cmd.
 */
export function renderExports(answers: SetupAnswers, shell: Shell): string {
  return configPairs(answers)
    .map(([key, value]) => {
      if (shell === 'posix') return `export ${key}='${value.replace(/'/g, `'\\''`)}'`;
      if (shell === 'powershell') return `$env:${key} = '${value.replace(/'/g, `''`)}'`;
      return `set "${key}=${value.replace(/%/g, '%%')}"`;
    })
    .join('\n');
}

/** Split pairs into [required, ...optional-as-singletons] for spacing in .env. */
function groupRequired(pairs: Array<[string, string]>): Array<Array<[string, string]>> {
  const requiredKeys = new Set(['TELEGRAM_BOT_TOKEN', 'TELEGRAM_ALLOWED_USERS', 'TELEGRAM_GROUP_ID']);
  const required = pairs.filter(([k]) => requiredKeys.has(k));
  const optional = pairs.filter(([k]) => !requiredKeys.has(k));
  return [required, ...optional.map((p) => [p])];
}

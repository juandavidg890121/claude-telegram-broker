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

/** A .env value, quoted only when it contains something that needs it. */
function envValue(value: string): string {
  return /[\s#"']/.test(value) ? `"${value.replace(/"/g, '\\"')}"` : value;
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

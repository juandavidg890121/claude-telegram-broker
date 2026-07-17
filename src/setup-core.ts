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

/** A value safe to put after `KEY=` in a .env line: no newline can smuggle in a
 *  second variable. Quotes only when needed, so simple values stay readable. */
function envValue(raw: string): string {
  const value = raw.replace(/[\r\n]+/g, ' ').trim();
  return /[\s#"']/.test(value) ? `"${value.replace(/"/g, '\\"')}"` : value;
}

/**
 * The exact text written to .env.
 *
 * Only what the user actually set — an installer that writes every optional key
 * commented-out is just .env.example, and the whole point was to not hand them
 * that. Required keys always; optional keys only when answered.
 */
export function renderEnv(answers: SetupAnswers): string {
  const lines: string[] = [
    '# Written by the telegram-broker setup. Re-run it to regenerate, or edit by hand.',
    '# See .env.example for every option and what it does.',
    '',
    `TELEGRAM_BOT_TOKEN=${envValue(answers.token)}`,
    `TELEGRAM_ALLOWED_USERS=${envValue(answers.allowedUsers.join(','))}`,
  ];

  if (answers.groupId) lines.push(`TELEGRAM_GROUP_ID=${envValue(answers.groupId)}`);

  const optional: Array<[string, string | undefined]> = [
    ['BROKER_DEFAULT_CWD', answers.defaultCwd],
    ['BROKER_MODEL', answers.model],
    ['BROKER_PERMISSION_MODE', answers.permissionMode],
    ['BROKER_ASK_TOOLS', answers.askTools],
    ['BROKER_WHISPER_DIR', answers.whisperDir],
    ['BROKER_WHISPER_MODEL', answers.whisperModel],
    ['BROKER_WHISPER_LANGUAGE', answers.whisperLanguage],
  ];
  const set = optional.filter((pair): pair is [string, string] => Boolean(pair[1]));
  if (set.length) {
    lines.push('');
    for (const [key, value] of set) lines.push(`${key}=${envValue(value)}`);
  }

  return lines.join('\n') + '\n';
}

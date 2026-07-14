import { homedir } from 'node:os';
import { join } from 'node:path';

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

function normalizeGroupId(raw: string): string {
  const id = raw.trim();
  if (!id || id.startsWith('-')) return id;
  console.warn(`[config] TELEGRAM_GROUP_ID=${id} is missing its leading '-'; using -${id}.`);
  return `-${id}`;
}

export const config = {
  telegram: {
    token: required('TELEGRAM_BOT_TOKEN'),
    /** Sender allowlist. Anything not on it is dropped silently. */
    allowedUsers: new Set(
      (process.env.TELEGRAM_ALLOWED_USERS ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    ),
    /**
     * Forum-enabled group where each topic is one session.
     *
     * Supergroup ids are negative. Copying one without its minus sign yields a
     * baffling `400: chat not found`, so absorb that here rather than make
     * everyone rediscover it.
     */
    groupId: normalizeGroupId(process.env.TELEGRAM_GROUP_ID ?? ''),
  },
  /** Working directory a new session starts in when none is given. */
  defaultCwd: process.env.BROKER_DEFAULT_CWD ?? homedir(),
  /** Where the topic-to-session registry lives. */
  stateFile: process.env.BROKER_STATE_FILE ?? join(homedir(), '.claude-telegram-broker.json'),
  model: process.env.BROKER_MODEL ?? undefined,
  permissionMode: (process.env.BROKER_PERMISSION_MODE ?? 'default') as
    | 'default'
    | 'acceptEdits'
    | 'plan'
    | 'bypassPermissions',
  /**
   * Tools that must always be confirmed from Telegram.
   *
   * This is load-bearing, not belt-and-braces: with `permissionMode: 'default'`
   * alone the SDK runs Bash without ever invoking `canUseTool`. Only an explicit
   * `ask` rule forces the prompt, so an empty list means Claude edits files and
   * runs shell commands on this machine unsupervised.
   */
  askTools: (process.env.BROKER_ASK_TOOLS ?? 'Bash,Write,Edit,NotebookEdit')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
};

if (config.telegram.allowedUsers.size === 0) {
  throw new Error(
    'TELEGRAM_ALLOWED_USERS is empty. An ungated bot lets anyone drive Claude on your machine — set it.',
  );
}

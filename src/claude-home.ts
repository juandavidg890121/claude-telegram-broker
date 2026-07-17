import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Claude Code's own directory — the one it keeps credentials and settings in.
 *
 * Not configurable, and that is the point of naming it. Claude Code owns this
 * path; this project only reads from it. Every *other* path in the broker takes
 * an env override (BROKER_MIRROR_DIR, BROKER_STATE_FILE) because the broker owns
 * those and you may move them. Pointing one of those overrides at this constant,
 * or deriving this constant from one of them, would send us looking for
 * credentials somewhere Claude Code never wrote them — and quota fails open, so
 * the symptom would be a suffix that silently stops appearing.
 *
 * Lives on its own rather than in config.ts because the hooks need it, and
 * config.ts throws at import unless the *broker's* env is present. Same reason
 * chunk.ts is its own file: a hook is not the broker.
 */
export const CLAUDE_HOME = join(homedir(), '.claude');

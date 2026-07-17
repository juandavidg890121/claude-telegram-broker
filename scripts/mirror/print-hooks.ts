/**
 * Print the /watch hook config with this checkout's real paths filled in.
 *
 *   pnpm run print-hooks
 *
 * Exists because the README used to show a `<repo>` placeholder, and a
 * placeholder pasted unexpanded fails in the worst possible way: the hook is a
 * command that cannot start, Claude Code shrugs and carries on, and /watch is
 * silently half-dead with no error anywhere pointing at the cause.
 */
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildHookConfig, tsxPath } from '../../src/hooks-config.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const tsx = tsxPath(root);
const env = join(root, '.env');

console.log('Prefer `pnpm setup`, which merges this for you. To do it by hand,');
console.log('merge this into the "hooks" object of ~/.claude/settings.json:\n');
console.log(JSON.stringify({ hooks: buildHookConfig(root) }, null, 2));

// Check the paths now, here, rather than let them fail invisibly inside a hook.
const problems = [
  !existsSync(tsx) && `tsx is missing at ${tsx} — run pnpm install first.`,
  !existsSync(env) && `no .env at ${env} — the Stop and AskUserQuestion hooks need TELEGRAM_BOT_TOKEN to send anything.`,
].filter(Boolean);

if (problems.length) {
  console.error(`\n⚠️  ${problems.join('\n⚠️  ')}`);
  process.exit(1);
}
console.log('\n✅ tsx and .env both present. Restart any Claude session for the hooks to load.');

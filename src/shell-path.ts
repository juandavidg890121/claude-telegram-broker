/**
 * Native filesystem paths vs. paths inside a Git Bash command line.
 *
 * Two different things, and conflating them is what broke /watch on Windows. A
 * path handed to existsSync()/spawn()/cwd must stay OS-native
 * (`C:\Users\First Last\broker`). A path pasted into a command string Claude
 * Code runs through Git Bash must be MSYS-style (`/c/Users/...`) *and* quoted,
 * because the default Windows install lives under a directory with a space in
 * it.
 *
 * Trying to satisfy both with one representation is the trap: making `root`
 * POSIX at the source fixes the command strings and breaks every existsSync()
 * that stats the same path. So paths are built natively with node:path
 * throughout, and converted only here — at the moment one stops being a path
 * and becomes part of a command.
 */

/**
 * A native absolute path in the form Git Bash resolves.
 *
 * A no-op on Linux/macOS, where there is no drive letter and no backslash to
 * rewrite, so callers never need to branch on process.platform. Both separators
 * are normalised because node:path's join() on a POSIX host appends with `/` to
 * a Windows root it was handed, leaving `C:\a\b/c` — and tolerating that mix is
 * what lets this be tested off Windows.
 */
export function toShellPath(nativePath: string): string {
  return nativePath.replace(/\\/g, '/').replace(/^([A-Za-z]):/, (_, drive: string) => `/${drive.toLowerCase()}`);
}

/**
 * A native path as a single shell word: converted, and quoted iff it needs it.
 *
 * Single quotes, so nothing inside is expanded — a path is a literal, and
 * `$` or a backtick in one should never reach the shell as syntax. The
 * `'\''` dance is the only way to carry a literal single quote through them.
 * Quoted only when something outside the safe set appears, so the commands
 * `print-hooks` shows a POSIX user stay readable instead of uniformly quoted.
 */
export function shellArg(nativePath: string): string {
  const converted = toShellPath(nativePath);
  return /[^A-Za-z0-9_@%+=:,./-]/.test(converted) ? `'${converted.replace(/'/g, `'\\''`)}'` : converted;
}

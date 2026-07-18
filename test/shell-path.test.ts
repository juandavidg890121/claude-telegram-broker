/**
 * The native-path/shell-path split, which is where /watch broke on Windows.
 *
 * These run identically on Linux CI. toShellPath is a pure string function, so
 * a real Windows path is passed in literally rather than faking
 * process.platform — the conversion is what needs testing, not the host.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { shellArg, toShellPath } from '../src/shell-path.js';

describe('toShellPath', () => {
  it('rewrites a Windows path into the MSYS form Git Bash resolves', () => {
    // `C:\...` and `/C:/...` are both things Git Bash will not open.
    assert.equal(toShellPath('C:\\Users\\dev\\broker'), '/c/Users/dev/broker');
  });

  it('lowercases the drive letter', () => {
    // MSYS mounts /d, not /D, and gives no useful error for the wrong one.
    assert.equal(toShellPath('D:\\work'), '/d/work');
  });

  it('handles the mixed separators node:path makes from a Windows root', () => {
    // join() on a POSIX host appends with '/', leaving `C:\a\b/c`. Normalising
    // both is what lets the rest of this suite run off Windows at all.
    assert.equal(toShellPath('C:\\Users\\dev/node_modules/.bin/tsx'), '/c/Users/dev/node_modules/.bin/tsx');
  });

  it('leaves POSIX paths untouched', () => {
    // The no-op that keeps Linux and macOS off the Windows code path entirely.
    assert.equal(toShellPath('/opt/broker/node_modules/.bin/tsx'), '/opt/broker/node_modules/.bin/tsx');
  });
});

describe('shellArg', () => {
  it('quotes a path with a space', () => {
    // `C:\Users\First Last` is the default Windows install. Unquoted, it splits
    // into two bogus arguments the moment the array becomes a command line.
    assert.equal(shellArg('C:\\Users\\John Doe\\broker'), `'/c/Users/John Doe/broker'`);
  });

  it('leaves a path that needs no quoting unquoted', () => {
    // Otherwise every command print-hooks shows a POSIX user grows noise.
    assert.equal(shellArg('/opt/broker'), '/opt/broker');
  });

  it('never emits a percent-encoded path', () => {
    // The regression this replaced: URL.pathname encodes the space as %20,
    // which reaches the shell literally and resolves to nothing.
    assert.doesNotMatch(shellArg('C:\\Users\\John Doe\\broker'), /%20/);
  });

  it('carries a literal quote through the quoting', () => {
    // Rare in a path, but the one input that turns naive quoting into a shell
    // syntax error rather than a wrong path.
    assert.equal(shellArg("/opt/it's"), `'/opt/it'\\''s'`);
  });

  it('does not let a path expand as shell syntax', () => {
    // Single quotes, so a `$` in a directory name stays a `$`.
    assert.equal(shellArg('/opt/$HOME/broker'), `'/opt/$HOME/broker'`);
  });
});

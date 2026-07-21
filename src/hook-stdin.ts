/**
 * Reading a hook's JSON payload from stdin.
 *
 * Its own module so the three hooks share one copy. hook-telegram.ts is the
 * wrong home for it: session-start-hook needs the read but sends nothing, and
 * importing it from there would drag the whole Telegram path in for one
 * function. Two copies was already a coincidence; a fix landing in one and not
 * the other is the failure this prevents.
 */

/**
 * Read a hook's JSON payload from stdin, resolving as soon as it is complete.
 *
 * The obvious version — `for await (const chunk of process.stdin)` — only
 * returns once stdin closes, and that is a hang waiting to happen: the payload
 * can arrive whole while the pipe stays open, and then the hook blocks forever
 * on an EOF that is never coming. The suspected cause of AskUserQuestion never
 * reaching Telegram on native Windows, where a *blocking* hook (PreToolUse,
 * whose output decides whether the tool runs) appears to keep its input pipe
 * open in a way a fire-and-forget Stop hook does not — which is why Stop works
 * there and this one does not, on the same read.
 *
 * So EOF is no longer what ends the read. Claude Code sends exactly one JSON
 * object, so the moment the buffer parses, everything that was coming has
 * arrived. `end` still resolves, for the ordinary case and for input that never
 * parses at all: callers JSON.parse the result and should see their own error,
 * not a silent hang.
 */
export function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    const text = (): string => Buffer.concat(chunks).toString('utf8');
    let settled = false;
    const done = (): void => {
      if (settled) return;
      settled = true;
      process.stdin.off('data', onData);
      process.stdin.off('end', done);
      resolve(text());
    };

    function onData(chunk: Buffer): void {
      chunks.push(chunk);
      try {
        JSON.parse(text());
      } catch {
        return; // A partial object so far — keep reading.
      }
      done();
    }

    process.stdin.on('data', onData);
    process.stdin.on('end', done);
  });
}

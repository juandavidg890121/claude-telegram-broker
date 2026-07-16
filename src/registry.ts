import { readFileSync, writeFileSync, renameSync } from 'node:fs';

/**
 * The only state the broker owns: which conversation maps to which Claude
 * session, and where that session runs. Everything else (transcripts, the list
 * of sessions Claude itself knows about) is already on disk under
 * ~/.claude/projects and is read through the SDK, not duplicated here.
 */
export type Entry = {
  conversationId: string;
  sessionId?: string;
  cwd: string;
  title: string;
  /**
   * Set by /mode. There is no native Claude Code command for permission mode,
   * so the broker owns it — and persists it so a resumed session keeps it.
   * The model is deliberately *not* here: Claude Code's own /model handles that,
   * and a second copy would fight it.
   */
  permissionMode?: string;
  /**
   * Set by /watch. Marks this conversation as *relaying into* a session someone
   * else drives (an interactive VS Code one), rather than one the broker owns.
   *
   * The broker never runs query() for a watched entry — not even as a fallback
   * when the session looks gone. That refusal is the whole design: two writers
   * on one session id corrupts the transcript, and liveness detection can only
   * ever be a guess, so the guess is never allowed to authorise a takeover.
   * See index.ts's onMessage, and /fork for the "branch it and drive it" path.
   */
  watch?: boolean;
};

export class Registry {
  private entries = new Map<string, Entry>();

  constructor(private readonly file: string) {
    try {
      const raw = JSON.parse(readFileSync(this.file, 'utf8')) as Entry[];
      for (const entry of raw) this.entries.set(entry.conversationId, entry);
    } catch {
      // No state file yet — start empty.
    }
  }

  get(conversationId: string): Entry | undefined {
    return this.entries.get(conversationId);
  }

  list(): Entry[] {
    return [...this.entries.values()];
  }

  put(entry: Entry): void {
    this.entries.set(entry.conversationId, entry);
    this.flush();
  }

  remove(conversationId: string): void {
    this.entries.delete(conversationId);
    this.flush();
  }

  private flush(): void {
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify([...this.entries.values()], null, 2));
    renameSync(tmp, this.file);
  }
}

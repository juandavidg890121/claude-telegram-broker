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
  /** Per-session overrides of the global defaults, set from Telegram. */
  permissionMode?: string;
  model?: string;
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

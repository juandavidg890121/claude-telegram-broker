import { readFileSync, renameSync, writeFileSync } from 'node:fs';

/**
 * Session<->Telegram mirror liveness: whether the Stop hook is actually
 * reaching Telegram, verified with real production traffic rather than a
 * synthetic protocol (see HeartbeatStore below).
 *
 * NOT the same "heartbeat" as src/mirror.ts's heartbeatFresh/HEARTBEAT_STALE_MS
 * — that one tracks whether the /watch poller PROCESS is alive (a 5-second
 * staleness window on a file the poller touches). This module tracks whether
 * the Stop-hook MIRROR is reaching Telegram (a minutes-scale window on a file
 * stop-hook.ts writes after a real successful send). Two different liveness
 * checks on two different components; the shared English word is coincidence,
 * not shared code — do not import one where the other is meant.
 */
export type PongRecord = { sessionId: string; lastPongAt: number };

/**
 * The pong-marker file. Written by stop-hook.ts — a short-lived process,
 * once per turn, right after a real successful Telegram send. Read by the
 * long-lived daemon's heartbeat scheduler (HeartbeatStore below). Its own
 * class, not folded into HeartbeatStore, because the two have different
 * writers on different schedules: HeartbeatStore.flush() runs from the
 * daemon's 30s scheduler tick, PongStore.recordPong() runs from a one-shot
 * hook process — conflating them into one file would mean those two writers
 * racing on the same file.
 */
export class PongStore {
  private records: PongRecord[] = [];

  constructor(private readonly file: string) {
    try {
      this.records = JSON.parse(readFileSync(this.file, 'utf8')) as PongRecord[];
    } catch {
      // No file yet, or corrupt — start empty, same convention as LoopStore.
    }
  }

  /** Atomic write via temp file + rename — see LoopStore.flush() in loops.ts
   *  for why a plain writeFileSync is not safe here. */
  private flush(): void {
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.records, null, 2));
    renameSync(tmp, this.file);
  }

  recordPong(sessionId: string): void {
    const now = Date.now();
    const existing = this.records.find((r) => r.sessionId === sessionId);
    if (existing) {
      existing.lastPongAt = now;
    } else {
      this.records.push({ sessionId, lastPongAt: now });
    }
    this.flush();
  }

  lastPongAt(sessionId: string): number | null {
    return this.records.find((r) => r.sessionId === sessionId)?.lastPongAt ?? null;
  }
}

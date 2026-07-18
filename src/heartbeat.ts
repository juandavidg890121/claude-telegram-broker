import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { formatDuration, parseDuration } from './loops.js';

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
  constructor(private readonly file: string) {}

  /** Re-read on every call, not cached — recordPong() runs in a fresh
   *  stop-hook.ts process each turn, separate from the daemon's own
   *  long-lived PongStore instance. Caching the array in memory (as an
   *  earlier version of this class did) meant the daemon's instance only
   *  ever saw whatever was on disk at its own startup: every pong written
   *  by stop-hook.ts afterward was invisible for the rest of the daemon's
   *  life, making every escalation check look at stale (or absent) data.
   *  A JSON file this small costs nothing to re-read on a 30s-tick /
   *  5-minute-floor schedule. */
  private load(): PongRecord[] {
    try {
      return JSON.parse(readFileSync(this.file, 'utf8')) as PongRecord[];
    } catch {
      // No file yet, or corrupt — start empty, same convention as LoopStore.
      return [];
    }
  }

  /** Atomic write via temp file + rename — see LoopStore.flush() in loops.ts
   *  for why a plain writeFileSync is not safe here. */
  private flush(records: PongRecord[]): void {
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(records, null, 2));
    renameSync(tmp, this.file);
  }

  recordPong(sessionId: string): void {
    const records = this.load();
    const now = Date.now();
    const existing = records.find((r) => r.sessionId === sessionId);
    if (existing) {
      existing.lastPongAt = now;
    } else {
      records.push({ sessionId, lastPongAt: now });
    }
    this.flush(records);
  }

  lastPongAt(sessionId: string): number | null {
    return this.load().find((r) => r.sessionId === sessionId)?.lastPongAt ?? null;
  }
}

/**
 * A heartbeat ping consumes a real turn every time it fires — unlike a loop,
 * which is opt-in per use case, this is meant to be a lightweight liveness
 * check running quietly in the background. loops.ts's 1-minute floor
 * (MIN_INTERVAL_MS) is too aggressive for that; 5 minutes is the floor here.
 */
export const MIN_HEARTBEAT_INTERVAL_MS = 5 * 60_000;

/** Same duration syntax as parseDuration, with a higher floor. */
export function parseHeartbeatInterval(text: string): number {
  const ms = parseDuration(text);
  if (ms < MIN_HEARTBEAT_INTERVAL_MS) {
    throw new Error(`Minimum heartbeat interval is ${formatDuration(MIN_HEARTBEAT_INTERVAL_MS)} — "${text}" is shorter.`);
  }
  return ms;
}

export type Heartbeat = {
  conversationId: string;
  intervalMs: number;
  nextPingAt: number;
  lastPingAt: number | null;
  escalated: boolean;
};

/**
 * One heartbeat per conversation, unlike LoopStore's several-per-conversation
 * loops — enabling a second one on an already-heartbeating conversation
 * replaces the first, the same way /reloop replaces a loop's settings but
 * without needing an id to name which one (there is only ever one).
 */
export class HeartbeatStore {
  private heartbeats: Heartbeat[] = [];

  constructor(private readonly file: string) {
    try {
      this.heartbeats = JSON.parse(readFileSync(this.file, 'utf8')) as Heartbeat[];
    } catch {
      // No file yet, or corrupt — start empty, same convention as LoopStore.
    }
  }

  private flush(): void {
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.heartbeats, null, 2));
    renameSync(tmp, this.file);
  }

  enable(conversationId: string, intervalMs: number): Heartbeat {
    this.heartbeats = this.heartbeats.filter((h) => h.conversationId !== conversationId);
    const hb: Heartbeat = {
      conversationId,
      intervalMs,
      nextPingAt: Date.now() + intervalMs,
      lastPingAt: null,
      escalated: false,
    };
    this.heartbeats.push(hb);
    this.flush();
    return hb;
  }

  disable(conversationId: string): boolean {
    const before = this.heartbeats.length;
    this.heartbeats = this.heartbeats.filter((h) => h.conversationId !== conversationId);
    if (this.heartbeats.length === before) return false;
    this.flush();
    return true;
  }

  get(conversationId: string): Heartbeat | undefined {
    return this.heartbeats.find((h) => h.conversationId === conversationId);
  }

  /** Every heartbeat due to ping right now, each rescheduled for its next
   *  tick before returning — same contract as LoopStore.takeDue. */
  takeDue(now: number = Date.now()): Heartbeat[] {
    const due = this.heartbeats.filter((h) => h.nextPingAt <= now);
    for (const hb of due) hb.nextPingAt = now + hb.intervalMs;
    if (due.length) this.flush();
    return due;
  }

  /** Records that a ping just went out, and whether it was the escalated
   *  (urgent) prompt or the normal one — read back by the next tick's
   *  pong-freshness check in index.ts's deliverHeartbeat. */
  markPinged(conversationId: string, escalated: boolean): void {
    const hb = this.heartbeats.find((h) => h.conversationId === conversationId);
    if (!hb) return;
    hb.lastPingAt = Date.now();
    hb.escalated = escalated;
    this.flush();
  }
}

/** Fixed prompt text — not user-configurable. This is a liveness check, not
 *  a second /loop; letting the user supply arbitrary text here would make it
 *  one, and the escalation message specifically needs to stay accurate about
 *  what it is asking the session to do. */
export const HEARTBEAT_PING_PROMPT = 'Heartbeat check — no action needed, just let this turn end normally.';

export const HEARTBEAT_ESCALATED_PROMPT =
  'URGENT: Telegram communication appears broken — no reply reached the watching ' +
  'Telegram topic after the last heartbeat ping. Investigate why the Stop hook ' +
  'mirror is not delivering (check settings.json hook paths, the broker daemon process, ' +
  'and TELEGRAM_BOT_TOKEN) and fix it now — this takes priority over anything else in ' +
  'progress. Once communication is confirmed working again, resume whatever you were ' +
  'doing before this ping interrupted it.';

const HEARTBEAT_TICK_MS = 30_000;

/** Identical 30-second-tick, due-item, reschedule-before-return shape to
 *  startLoopScheduler in loops.ts — kept as its own function rather than a
 *  shared generic, since the two due-item shapes (Loop vs Heartbeat) differ
 *  and a shared abstraction over two call sites this small would cost more
 *  clarity than it saves. */
export function startHeartbeatScheduler(
  store: HeartbeatStore,
  deliver: (hb: Heartbeat) => Promise<void>,
): NodeJS.Timeout {
  return setInterval(() => {
    for (const hb of store.takeDue()) {
      deliver(hb).catch((error) => {
        console.error(`[heartbeat] delivery failed for ${hb.conversationId}: ${error instanceof Error ? error.message : String(error)}`);
      });
    }
  }, HEARTBEAT_TICK_MS);
}

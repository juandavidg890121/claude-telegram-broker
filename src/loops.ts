import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';

/**
 * Scheduled prompts: fire a fixed piece of text into a conversation on a
 * repeating interval, exactly as if it had been typed there.
 *
 * There is no Bot API for reaching into Telegram's own client-side "schedule
 * message" feature — that is a contract between the user's phone and
 * Telegram's servers, invisible to bots entirely. So this is the broker's own
 * timer, not a wrapper around Telegram's: a loop's due prompt is delivered
 * through the exact same path a real inbound message takes (deliverMessage in
 * index.ts), so a loop behaves indistinguishably from the user having typed
 * it — watched-session routing, permission prompts, everything included.
 */
export type Loop = {
  id: string;
  conversationId: string;
  intervalMs: number;
  prompt: string;
  nextFireAt: number;
  createdAt: number;
};

const DURATION = /^(\d+)(s|m|h|d)$/;

/**
 * The shortest interval worth allowing. A turn routinely outlives a minute, so
 * this does not stop a loop from being asked for again before the last answer
 * landed — that is the scheduler's job, not the parser's. What it stops is the
 * obviously silly end of the range.
 */
export const MIN_INTERVAL_MS = 60_000;

/** "1m", "30m", "2h", "1d" — the units a phone screen has room for typing. */
export function parseDuration(text: string): number {
  const match = DURATION.exec(text.trim());
  // Every example here must survive the minimum below. Suggesting "45s" — as
  // this once did — sends someone who typed a bad duration to type a rejected
  // one, and the second error looks like the tool contradicting itself.
  if (!match) throw new Error(`"${text}" isn't a duration. Use e.g. 5m, 30m, 2h, 1d.`);
  const value = Number(match[1]);
  const unitMs = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 }[match[2] as 's' | 'm' | 'h' | 'd'];
  const ms = value * unitMs;
  if (ms < MIN_INTERVAL_MS) {
    throw new Error(`Minimum loop interval is ${formatDuration(MIN_INTERVAL_MS)} — "${text}" is shorter.`);
  }
  return ms;
}

export function formatDuration(ms: number): string {
  if (ms % 86_400_000 === 0) return `${ms / 86_400_000}d`;
  if (ms % 3_600_000 === 0) return `${ms / 3_600_000}h`;
  if (ms % 60_000 === 0) return `${ms / 60_000}m`;
  return `${Math.round(ms / 1_000)}s`;
}

export class LoopStore {
  private loops: Loop[] = [];

  constructor(private readonly file: string) {
    try {
      this.loops = JSON.parse(readFileSync(this.file, 'utf8')) as Loop[];
    } catch {
      // No file yet — start empty, same convention as Registry.
    }
  }

  /**
   * Write via a temp file and rename, which is what Registry does and what this
   * claimed to be doing.
   *
   * rename is atomic: readers see the old file or the new one, never a half of
   * either. A plain writeFileSync can be interrupted mid-write, and the
   * constructor above reads a truncated file as "no loops" — so a kill at the
   * wrong instant silently drops every scheduled loop, and the next add()
   * overwrites the remains. takeDue() flushes on every tick that has work, so
   * that window reopens every 30 seconds for as long as the broker runs.
   */
  private flush(): void {
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.loops, null, 2));
    renameSync(tmp, this.file);
  }

  add(conversationId: string, intervalMs: number, prompt: string): Loop {
    const loop: Loop = {
      id: randomBytes(3).toString('hex'),
      conversationId,
      intervalMs,
      prompt,
      nextFireAt: Date.now() + intervalMs,
      createdAt: Date.now(),
    };
    this.loops.push(loop);
    this.flush();
    return loop;
  }

  /** Loops belonging to one conversation, oldest first — the order they were made. */
  listFor(conversationId: string): Loop[] {
    return this.loops.filter((l) => l.conversationId === conversationId);
  }

  /** Only removes within the given conversation, so one topic can't cancel another's loop by guessing its id. */
  remove(conversationId: string, id: string): boolean {
    const before = this.loops.length;
    this.loops = this.loops.filter((l) => !(l.conversationId === conversationId && l.id === id));
    if (this.loops.length === before) return false;
    this.flush();
    return true;
  }

  edit(conversationId: string, id: string, intervalMs: number, prompt: string): Loop | undefined {
    const loop = this.loops.find((l) => l.conversationId === conversationId && l.id === id);
    if (!loop) return undefined;
    loop.intervalMs = intervalMs;
    loop.prompt = prompt;
    loop.nextFireAt = Date.now() + intervalMs;
    this.flush();
    return loop;
  }

  /** Every loop due to fire right now, each rescheduled for its next tick before returning. */
  takeDue(now: number = Date.now()): Loop[] {
    const due = this.loops.filter((l) => l.nextFireAt <= now);
    for (const loop of due) loop.nextFireAt = now + loop.intervalMs;
    if (due.length) this.flush();
    return due;
  }
}

/**
 * Which loops have already said they can't deliver, so they say it once.
 *
 * A loop pointed at a watched session that has since been closed cannot fire,
 * and it will go on not firing until you reopen it. Reporting that on every
 * pass means a wall of text every 30 minutes for as long as the loop lives —
 * which is how a topic becomes something you swipe away without reading, taking
 * the messages that did matter with it. Report the first miss, then go quiet
 * until it lands again.
 *
 * Its own type because it is the only part of a loop's life with a memory, and
 * memory is what can be quietly wrong for a week: forget to rearm and the loop
 * never warns again; forget to mute and nothing changed. Same shape as the
 * quota alert's hysteresis, for the same reason.
 */
export class LoopComplaints {
  private quiet = new Set<string>();

  /** Record what happened, and answer whether the user should hear about it. */
  shouldReport(loopId: string, outcome: 'delivered' | 'not-listening'): boolean {
    if (outcome === 'delivered') {
      // Rearm: the *next* outage is news again.
      this.quiet.delete(loopId);
      return false;
    }
    if (this.quiet.has(loopId)) return false;
    this.quiet.add(loopId);
    return true;
  }

  /** A cancelled loop leaves nothing behind to mute. */
  forget(loopId: string): void {
    this.quiet.delete(loopId);
  }
}

const TICK_MS = 30_000;

/**
 * Polls for due loops on a fixed tick rather than one timer per loop —
 * simpler to persist (nextFireAt is just a number, no live timer handle to
 * reconstruct on restart) and the 30s granularity is invisible against
 * minute-or-longer intervals. Rescheduling from the fire time keeps a loop on
 * the tick grid rather than drifting a little later on every pass.
 *
 * `deliver` gets the whole Loop, not just its text: what to do when a prompt
 * cannot be delivered depends on which loop it was — whether this one has
 * already complained, whether its conversation is mid-turn — and none of that
 * is timing, which is all this file knows about.
 */
export function startLoopScheduler(store: LoopStore, deliver: (loop: Loop) => Promise<void>): NodeJS.Timeout {
  return setInterval(() => {
    for (const loop of store.takeDue()) {
      deliver(loop).catch((error) => {
        // A delivery failure must not stop the scheduler or drop the loop — it
        // already fires again next interval.
        console.error(`[loops] delivery failed for ${loop.id}: ${error instanceof Error ? error.message : String(error)}`);
      });
    }
  }, TICK_MS);
}

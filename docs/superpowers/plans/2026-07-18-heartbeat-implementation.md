# Heartbeat (session↔Telegram liveness check) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An optional, per-conversation `/heartbeat` command that periodically verifies the Stop-hook mirror (session → Telegram) is actually alive, and escalates to an urgent in-session prompt when a ping goes unanswered.

**Architecture:** A pong-marker file (`PongStore`) that `stop-hook.ts` writes to on every real successful Telegram send; a per-conversation schedule file (`HeartbeatStore`) that a 30-second-tick scheduler in `index.ts` reads, mirroring `loops.ts`'s `LoopStore`/`startLoopScheduler` pattern exactly. A due heartbeat checks whether a pong landed since its last ping — fresh means a normal liveness prompt, stale means an urgent "fix this now" prompt — then delivers it through the same `deliverMessage` path `/loop` already uses.

**Tech Stack:** TypeScript, Node's built-in `node:test` runner (`node --import tsx --test`), the existing `LoopStore`/`loops.ts` conventions (atomic temp-file-then-rename JSON persistence).

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-18-heartbeat-design.md` (committed `a8edcc0`) — every task's requirements come from there; this section only calls out values easy to get wrong by copying the wrong sibling file.
- Minimum heartbeat interval: **5 minutes** (`MIN_HEARTBEAT_INTERVAL_MS = 5 * 60_000`), distinct from `loops.ts`'s 1-minute `MIN_INTERVAL_MS`.
- Prompt text is **fixed**, not user-supplied — the `/heartbeat` command takes only an interval argument, never a prompt.
- **Naming collision to avoid, deliberately:** `src/mirror.ts` already exports `HEARTBEAT_STALE_MS`/`heartbeatFresh`/`heartbeatPath` — an *unrelated* concept (whether the `/watch` **poller** process is alive, 5-second staleness window). This plan's `Heartbeat`/`HeartbeatStore` (whether the **Stop-hook mirror** is alive, minutes-scale) is a different liveness check on a different component. Task 2 requires a doc comment at the top of the new file making this distinction explicit, so nobody conflates the two `heartbeat`-named things while reading the codebase.
- One heartbeat per conversation (not several, unlike loops) — a second `/heartbeat` call replaces the existing one.
- All commits go straight to `main` in this repo (established convention this session) — no PR needed unless asked.
- Test command: `npm test` runs `node --import tsx --test --test-concurrency=1 test/*.test.ts` — new `*.test.ts` files under `test/` are picked up automatically, no registration needed.

---

### Task 1: PongStore — the pong-marker file `stop-hook.ts` writes to

**Files:**
- Create: `src/heartbeat.ts` (this task adds only the `PongStore` half; Task 2 adds `HeartbeatStore` to the same file)
- Test: `test/heartbeat.test.ts`

**Interfaces:**
- Consumes: nothing (pure, file-backed, no dependency on other new code).
- Produces: `export class PongStore { constructor(file: string); recordPong(sessionId: string): void; lastPongAt(sessionId: string): number | null; }` and `export type PongRecord = { sessionId: string; lastPongAt: number };` — Task 3 (`stop-hook.ts`) calls `recordPong`; Task 4 (`index.ts` scheduler) calls `lastPongAt`.

- [ ] **Step 1: Write the failing tests**

Create `test/heartbeat.test.ts`:

```ts
/**
 * Session<->Telegram liveness: the pong-marker file stop-hook.ts writes to
 * on every real successful mirror, and the per-conversation ping schedule
 * that reads it.
 *
 * NOT the same "heartbeat" as src/mirror.ts's heartbeatFresh — that one
 * tracks whether the /watch poller process is alive (5s staleness). This
 * one tracks whether the Stop-hook mirror is reaching Telegram at all
 * (minutes-scale). Two different liveness checks on two different
 * components that happen to share an English word.
 */
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { PongStore } from '../src/heartbeat.js';

const dir = mkdtempSync(join(tmpdir(), 'broker-heartbeat-'));

describe('PongStore', () => {
  it('starts with no record for a session it has never heard of', () => {
    const store = new PongStore(join(dir, 'a.json'));
    assert.equal(store.lastPongAt('sess-1'), null);
  });

  it('records and reads back a pong', () => {
    const store = new PongStore(join(dir, 'b.json'));
    const before = Date.now();
    store.recordPong('sess-1');
    const at = store.lastPongAt('sess-1');
    assert.ok(at !== null && at >= before);
  });

  it('persists across instances, keyed by file', () => {
    const file = join(dir, 'c.json');
    new PongStore(file).recordPong('sess-1');
    const reloaded = new PongStore(file);
    assert.ok(reloaded.lastPongAt('sess-1') !== null);
  });

  it('keeps sessions apart', () => {
    const store = new PongStore(join(dir, 'd.json'));
    store.recordPong('sess-1');
    assert.equal(store.lastPongAt('sess-2'), null);
  });

  it('a later recordPong overwrites the earlier timestamp for the same session', async () => {
    const store = new PongStore(join(dir, 'e.json'));
    store.recordPong('sess-1');
    const first = store.lastPongAt('sess-1');
    await new Promise((resolve) => setTimeout(resolve, 5));
    store.recordPong('sess-1');
    const second = store.lastPongAt('sess-1');
    assert.ok(second !== null && first !== null && second > first);
  });

  it('replaces the file rather than overwriting it in place', () => {
    // Same atomicity concern as LoopStore: a plain writeFileSync truncates the
    // existing file in place, and a kill mid-write leaves the next read seeing
    // corrupt/truncated JSON. rename() swaps in a new file, changing the inode.
    const file = join(dir, 'atomic.json');
    const store = new PongStore(file);
    store.recordPong('sess-1');
    const first = statSync(file).ino;

    store.recordPong('sess-2');
    assert.notEqual(statSync(file).ino, first, 'each write must land as a rename, not an in-place write');
    assert.equal(existsSync(`${file}.tmp`), false);
  });

  it('reads a corrupt file as empty rather than crashing', () => {
    const file = join(dir, 'corrupt.json');
    require('node:fs').writeFileSync(file, '[{"sessionId":"a');
    assert.equal(new PongStore(file).lastPongAt('sess-1'), null);
  });

  it('starts empty when the file does not exist yet', () => {
    const store = new PongStore(join(dir, 'does-not-exist.json'));
    assert.equal(store.lastPongAt('sess-1'), null);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /path/to/claude-telegram-broker && npx tsx --test test/heartbeat.test.ts`
Expected: FAIL — `Cannot find module '../src/heartbeat.js'` (the file doesn't exist yet).

- [ ] **Step 3: Write the minimal implementation**

Create `src/heartbeat.ts`:

```ts
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx tsx --test test/heartbeat.test.ts`
Expected: PASS, all 8 tests green.

- [ ] **Step 5: Commit**

```bash
git add src/heartbeat.ts test/heartbeat.test.ts
git commit -m "feat(heartbeat): add PongStore, the Stop-hook mirror liveness marker"
```

---

### Task 2: HeartbeatStore and LoopComplaints-shared error handling

**Files:**
- Modify: `src/heartbeat.ts` (add to the file Task 1 created)
- Test: `test/heartbeat.test.ts` (add to the file Task 1 created)

**Interfaces:**
- Consumes: nothing new from Task 1 directly (parallel sibling in the same file); reuses `parseDuration`/`formatDuration` imported from `../loops.js` for interval parsing (per spec: heartbeat has its own floor, not `loops.ts`'s `MIN_INTERVAL_MS`).
- Produces:
  ```ts
  export type Heartbeat = {
    conversationId: string;
    intervalMs: number;
    nextPingAt: number;
    lastPingAt: number | null;
    escalated: boolean;
  };
  export const MIN_HEARTBEAT_INTERVAL_MS: number; // 5 * 60_000
  export function parseHeartbeatInterval(text: string): number; // like parseDuration, floor = MIN_HEARTBEAT_INTERVAL_MS
  export class HeartbeatStore {
    constructor(file: string);
    enable(conversationId: string, intervalMs: number): Heartbeat;
    disable(conversationId: string): boolean;
    get(conversationId: string): Heartbeat | undefined;
    takeDue(now?: number): Heartbeat[]; // reschedules nextPingAt before returning, like LoopStore.takeDue
    markPinged(conversationId: string, escalated: boolean): void; // sets lastPingAt=now, escalated=escalated
  }
  export function startHeartbeatScheduler(
    store: HeartbeatStore,
    deliver: (hb: Heartbeat) => Promise<void>,
  ): NodeJS.Timeout; // identical 30s-tick shape to startLoopScheduler
  ```
  Task 4 (`index.ts`) consumes all of the above plus `PongStore` from Task 1.

- [ ] **Step 1: Write the failing tests**

Append to `test/heartbeat.test.ts` (add these imports to the existing import block at the top):

```ts
import {
  HeartbeatStore,
  MIN_HEARTBEAT_INTERVAL_MS,
  PongStore,
  parseHeartbeatInterval,
  startHeartbeatScheduler,
  type Heartbeat,
} from '../src/heartbeat.js';
```

Then append these `describe` blocks at the end of the file:

```ts
describe('parseHeartbeatInterval', () => {
  it('parses the same units as parseDuration', () => {
    assert.equal(parseHeartbeatInterval('30m'), 30 * 60_000);
    assert.equal(parseHeartbeatInterval('2h'), 2 * 3_600_000);
  });

  it('rejects anything shorter than 5 minutes — a loops.ts 1m interval is too aggressive here', () => {
    assert.throws(() => parseHeartbeatInterval('2m'), /minimum/i);
    assert.doesNotThrow(() => parseHeartbeatInterval('5m'));
  });

  it('has a 5-minute floor, distinct from loops.ts', () => {
    assert.equal(MIN_HEARTBEAT_INTERVAL_MS, 5 * 60_000);
  });
});

describe('HeartbeatStore', () => {
  it('starts with nothing enabled', () => {
    const store = new HeartbeatStore(join(dir, 'hb-a.json'));
    assert.equal(store.get('-100:1'), undefined);
  });

  it('enable schedules the first ping one interval out', () => {
    const store = new HeartbeatStore(join(dir, 'hb-b.json'));
    const before = Date.now();
    const hb = store.enable('-100:1', 10 * 60_000);
    assert.equal(hb.conversationId, '-100:1');
    assert.equal(hb.intervalMs, 10 * 60_000);
    assert.equal(hb.lastPingAt, null);
    assert.equal(hb.escalated, false);
    assert.ok(hb.nextPingAt >= before + 10 * 60_000);
  });

  it('a second enable on the same conversation replaces the first — one heartbeat per conversation', () => {
    const store = new HeartbeatStore(join(dir, 'hb-c.json'));
    store.enable('-100:1', 10 * 60_000);
    const replaced = store.enable('-100:1', 20 * 60_000);
    assert.equal(replaced.intervalMs, 20 * 60_000);
    assert.equal(store.get('-100:1')?.intervalMs, 20 * 60_000);
  });

  it('disable removes it, and reports whether there was anything to remove', () => {
    const store = new HeartbeatStore(join(dir, 'hb-d.json'));
    assert.equal(store.disable('-100:1'), false, 'nothing enabled yet');
    store.enable('-100:1', 10 * 60_000);
    assert.equal(store.disable('-100:1'), true);
    assert.equal(store.get('-100:1'), undefined);
  });

  it('persists across instances, keyed by file', () => {
    const file = join(dir, 'hb-e.json');
    new HeartbeatStore(file).enable('-100:1', 10 * 60_000);
    const reloaded = new HeartbeatStore(file);
    assert.equal(reloaded.get('-100:1')?.intervalMs, 10 * 60_000);
  });

  it('takeDue returns only what is due, and reschedules it', () => {
    const store = new HeartbeatStore(join(dir, 'hb-f.json'));
    store.enable('-100:1', 10 * 60_000);
    assert.equal(store.takeDue(Date.now()).length, 0, 'not due yet');

    const due = store.takeDue(Date.now() + 10 * 60_000 + 1_000);
    assert.equal(due.length, 1);
    assert.equal(due[0].conversationId, '-100:1');

    assert.equal(store.takeDue(Date.now() + 10 * 60_000 + 1_000).length, 0, 'rescheduled, not due again immediately');
  });

  it('markPinged records lastPingAt and the escalation flag', () => {
    const store = new HeartbeatStore(join(dir, 'hb-g.json'));
    store.enable('-100:1', 10 * 60_000);
    const before = Date.now();
    store.markPinged('-100:1', true);
    const hb = store.get('-100:1');
    assert.ok((hb?.lastPingAt ?? 0) >= before);
    assert.equal(hb?.escalated, true);
  });

  it('reads a corrupt file as empty rather than crashing', () => {
    const file = join(dir, 'hb-corrupt.json');
    require('node:fs').writeFileSync(file, '[{"conversationId":"a');
    assert.equal(new HeartbeatStore(file).get('-100:1'), undefined);
  });
});

describe('startHeartbeatScheduler', () => {
  const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

  it('delivers a due heartbeat, and does not deliver one that is not due', async (t) => {
    t.mock.timers.enable({ apis: ['setInterval', 'Date'] });
    const store = new HeartbeatStore(join(dir, 'hb-sched-a.json'));
    store.enable('-100:1', 10 * 60_000);

    const delivered: Heartbeat[] = [];
    const handle = startHeartbeatScheduler(store, async (hb) => {
      delivered.push(hb);
    });

    t.mock.timers.tick(5 * 60_000);
    await tick();
    assert.equal(delivered.length, 0, 'not due yet');

    t.mock.timers.tick(6 * 60_000);
    await tick();
    assert.equal(delivered.length, 1);
    assert.equal(delivered[0].conversationId, '-100:1');
    clearInterval(handle);
  });

  it('keeps ticking after a delivery throws', async (t) => {
    t.mock.timers.enable({ apis: ['setInterval', 'Date'] });
    const store = new HeartbeatStore(join(dir, 'hb-sched-b.json'));
    store.enable('-100:1', 10 * 60_000);

    let calls = 0;
    const handle = startHeartbeatScheduler(store, async () => {
      calls += 1;
      throw new Error('Telegram is down');
    });

    t.mock.timers.tick(11 * 60_000);
    await tick();
    assert.equal(calls, 1);

    t.mock.timers.tick(10 * 60_000);
    await tick();
    assert.equal(calls, 2, 'still firing after the first one threw');
    clearInterval(handle);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx tsx --test test/heartbeat.test.ts`
Expected: FAIL — `HeartbeatStore`/`parseHeartbeatInterval`/`startHeartbeatScheduler`/`MIN_HEARTBEAT_INTERVAL_MS` are not exported yet.

- [ ] **Step 3: Write the minimal implementation**

Append to `src/heartbeat.ts` (add this import at the top of the file, alongside the existing `node:fs` import):

```ts
import { formatDuration, parseDuration } from './loops.js';
```

Then append to the end of `src/heartbeat.ts`:

```ts
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx tsx --test test/heartbeat.test.ts`
Expected: PASS, all tests green (8 from Task 1 + the new ones from this task).

- [ ] **Step 5: Commit**

```bash
git add src/heartbeat.ts test/heartbeat.test.ts
git commit -m "feat(heartbeat): add HeartbeatStore and its 30s-tick scheduler"
```

---

### Task 3: Wire `recordPong` into `stop-hook.ts`

**Files:**
- Modify: `scripts/mirror/stop-hook.ts:21-95` (the `main()` call site and the whole `mirrorReply` function)
- Test: `test/stop-hook.test.ts` — check if this file already exists first (`ls test/ | grep stop-hook`); if it does, add to it following its existing mocking pattern. If it does not exist, create it following `test/heartbeat.test.ts`'s style, mocking `../src/hook-telegram.js`'s `send` the same way this file already needs to be mocked for any test of `mirrorReply` to run without a real network call — read `scripts/mirror/ask-user-question-hook.ts`'s existing tests (if any target the same `hook-telegram.js` module) for the established mock shape before inventing a new one.

**Interfaces:**
- Consumes: `PongStore` from Task 1 (`import { PongStore } from '../../src/heartbeat.js';`), `config.pongFile` from Task 3b below.
- Produces: nothing new consumed by later tasks — this is a leaf wiring task. `stop-hook.ts` itself is not imported by anything else in the codebase (it is a hook entry point, invoked as a subprocess by Claude Code).

**Step 3a: add `config.pongFile`**

- [ ] **Step 1: Modify `src/config.ts`**

Find this line (currently at `src/config.ts:59`):

```ts
  loopsFile: process.env.BROKER_LOOPS_FILE ?? join(homedir(), '.claude-telegram-broker-loops.json'),
```

Add immediately after it:

```ts
  /** Where the Stop-hook mirror liveness marker lives — see src/heartbeat.ts. */
  pongFile: process.env.BROKER_PONG_FILE ?? join(homedir(), '.claude-telegram-broker-pong.json'),
```

No test for this step alone — `config.ts` has no dedicated test file in this repo (confirm with `ls test/ | grep config` before assuming; if one exists, add a one-line assertion that `config.pongFile` is a non-empty string, matching whatever pattern that file already uses for `loopsFile`).

**Step 3b: `recordPong` call site**

- [ ] **Step 2: Write the failing test**

If `test/stop-hook.test.ts` does not exist yet, create it:

```ts
/**
 * stop-hook.ts's mirrorReply: mirrors a reply to Telegram, and records a
 * pong (src/heartbeat.ts's PongStore) only when a chunk actually sent —
 * not merely attempted. A loop/message delivery failure elsewhere in the
 * broker is not evidence this pipeline works; only a real successful send is.
 */
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, mock } from 'node:test';

import { PongStore } from '../src/heartbeat.js';

const dir = mkdtempSync(join(tmpdir(), 'broker-stop-hook-'));

// mirrorReply is not exported today — Step 3 below exports it so it is
// directly testable, matching how loops.ts exports its internals for
// loops.test.ts rather than only testing through the CLI entry point.
describe('mirrorReply', () => {
  it('records a pong after a real successful send', async () => {
    process.env.BROKER_PONG_FILE = join(dir, 'pong-a.json');
    process.env.TELEGRAM_BOT_TOKEN = 'test-token';
    const sendMock = mock.fn(async () => {});
    const { mirrorReply } = await import(`../scripts/mirror/stop-hook.js?t=${Date.now()}`);
    // NOTE for the implementer: if stop-hook.ts's `send` import cannot be
    // mocked via a query-string cache-bust re-import (ESM module mocking is
    // the fragile part of this test), use node:test's built-in module mocking
    // (`mock.module('../src/hook-telegram.js', { namedExports: { send: sendMock } })`,
    // available in Node 22+) instead — check the Node version this repo
    // targets (package.json engines field) before choosing which approach
    // compiles. Either way, the assertion below is what must hold.
    await mirrorReply('-100:1', 'sess-1', 'hello');
    const pong = new PongStore(process.env.BROKER_PONG_FILE).lastPongAt('sess-1');
    assert.ok(pong !== null, 'a successful send must record a pong');
  });

  it('does not record a pong when every chunk fails to send', async () => {
    process.env.BROKER_PONG_FILE = join(dir, 'pong-b.json');
    process.env.TELEGRAM_BOT_TOKEN = 'test-token';
    const { mirrorReply } = await import(`../scripts/mirror/stop-hook.js?t=${Date.now()}`);
    // Same mocking note as above applies — this test needs `send` to throw.
    await mirrorReply('-100:1', 'sess-1', 'hello');
    const pong = new PongStore(process.env.BROKER_PONG_FILE).lastPongAt('sess-1');
    assert.equal(pong, null, 'a fully-failed send must not record a pong');
  });

  it('does not record a pong when there is no text to mirror', async () => {
    process.env.BROKER_PONG_FILE = join(dir, 'pong-c.json');
    const { mirrorReply } = await import(`../scripts/mirror/stop-hook.js?t=${Date.now()}`);
    await mirrorReply('-100:1', 'sess-1', undefined);
    const pong = new PongStore(process.env.BROKER_PONG_FILE).lastPongAt('sess-1');
    assert.equal(pong, null);
  });
});
```

**If mocking `send` cleanly turns out to be impractical** (this file imports `send` directly from `../../src/hook-telegram.js` at module load time, and ESM mocking is genuinely awkward without a DI seam) — the implementer should instead refactor `mirrorReply` to accept `send` as an optional parameter defaulting to the real import, e.g. `async function mirrorReply(conversationId: string, sessionId: string, text: string | undefined, sendFn = send): Promise<void>`, and pass a mock directly in the test rather than fighting module mocking. This is a reasonable, small deviation from the exact signature below if the implementer hits that wall — note it in the task's completion report either way, since Task 4/the plan's other tasks do not depend on this function's exact parameter list beyond the first three (`conversationId`, `sessionId`, `text`).

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx tsx --test test/stop-hook.test.ts`
Expected: FAIL — `mirrorReply` is not exported from `scripts/mirror/stop-hook.ts` yet (or the module import fails outright), and `BROKER_PONG_FILE` is not yet read by `config.ts`'s `pongFile` if Step 1 above wasn't done first — do Step 1 before this step.

- [ ] **Step 4: Write the minimal implementation**

In `scripts/mirror/stop-hook.ts`, add this import alongside the existing ones at the top of the file:

```ts
import { PongStore } from '../../src/heartbeat.js';
import { config } from '../../src/config.js';
```

Replace the `main()` function's call to `mirrorReply` — find:

```ts
  await mirrorReply(entry.conversationId, payload.last_assistant_message?.trim());
```

Replace with:

```ts
  await mirrorReply(entry.conversationId, sessionId, payload.last_assistant_message?.trim());
```

Replace the whole `mirrorReply` function — find:

```ts
async function mirrorReply(conversationId: string, text: string | undefined): Promise<void> {
  // The hook input already carries the reply text, so there is no transcript to
  // open and parse. The SDK documents this field as existing precisely for that.
  if (!text) return;

  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    // Loud, because this is the difference between "not watched" and
    // "misconfigured", and the silent version of this bug is unfindable: the
    // mirror simply never speaks and nothing anywhere says why.
    console.error(
      '[stop-hook] this session is watched from Telegram but TELEGRAM_BOT_TOKEN is unset — ' +
        'no reply was mirrored. Point the hook at the broker .env (see README).',
    );
    return;
  }

  // Chunked here rather than through notify(): the suffix has to be appended
  // *after* the split so it always lands on the last chunk. Adding it before
  // would let chunkify push it onto a page of its own — which is the separate
  // message this design exists to avoid.
  const { chatId, threadId } = target(conversationId);
  const chunks = chunkify(text);
  // It rides along inside the chunk because chunkify's MAX_LEN leaves ~90
  // characters of head room under Telegram's real 4096 cap — enough for this
  // line, which is why it does not need a message of its own.
  const suffix = await quotaSuffix();
  if (suffix && chunks.length > 0) chunks[chunks.length - 1] += suffix;

  for (const chunk of chunks) {
    try {
      await send(token, chatId, threadId, chunk);
    } catch (error) {
      // Best-effort: a Telegram hiccup must never fail the real session's turn.
      console.error(`[stop-hook] ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
```

With:

```ts
/**
 * Exported (not just called from main()) so it is directly testable — see
 * test/stop-hook.test.ts.
 */
export async function mirrorReply(conversationId: string, sessionId: string, text: string | undefined): Promise<void> {
  // The hook input already carries the reply text, so there is no transcript to
  // open and parse. The SDK documents this field as existing precisely for that.
  if (!text) return;

  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    // Loud, because this is the difference between "not watched" and
    // "misconfigured", and the silent version of this bug is unfindable: the
    // mirror simply never speaks and nothing anywhere says why.
    console.error(
      '[stop-hook] this session is watched from Telegram but TELEGRAM_BOT_TOKEN is unset — ' +
        'no reply was mirrored. Point the hook at the broker .env (see README).',
    );
    return;
  }

  // Chunked here rather than through notify(): the suffix has to be appended
  // *after* the split so it always lands on the last chunk. Adding it before
  // would let chunkify push it onto a page of its own — which is the separate
  // message this design exists to avoid.
  const { chatId, threadId } = target(conversationId);
  const chunks = chunkify(text);
  // It rides along inside the chunk because chunkify's MAX_LEN leaves ~90
  // characters of head room under Telegram's real 4096 cap — enough for this
  // line, which is why it does not need a message of its own.
  const suffix = await quotaSuffix();
  if (suffix && chunks.length > 0) chunks[chunks.length - 1] += suffix;

  // Tracks whether ANY chunk actually reached Telegram — a heartbeat pong is
  // only recorded on real success, not merely on having tried. A multi-chunk
  // message could partially fail; even one successful chunk is real evidence
  // the mirror pipeline works, so this is `||=`, not "all must succeed".
  let sentOk = false;
  for (const chunk of chunks) {
    try {
      await send(token, chatId, threadId, chunk);
      sentOk = true;
    } catch (error) {
      // Best-effort: a Telegram hiccup must never fail the real session's turn.
      console.error(`[stop-hook] ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  if (sentOk) new PongStore(config.pongFile).recordPong(sessionId);
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx tsx --test test/stop-hook.test.ts`
Expected: PASS. If the mocking approach noted in Step 2 needed adjusting (the `send` DI-parameter fallback), re-run after that adjustment instead — either way this step ends with the three tests green.

- [ ] **Step 6: Run the full test suite to confirm nothing else broke**

Run: `npm test`
Expected: PASS — same pass count as before this task, plus the new tests from Tasks 1-3, no regressions (the one known-flaky `asks.test.ts` "final gap" failure pre-dates this plan entirely — see the design spec's context if it shows up again, it is not caused by this work).

- [ ] **Step 7: Commit**

```bash
git add src/config.ts scripts/mirror/stop-hook.ts test/stop-hook.test.ts
git commit -m "feat(heartbeat): record a pong on every real successful Stop-hook mirror"
```

---

### Task 4: Scheduler, `deliverHeartbeat`, and `/heartbeat` commands in `index.ts`

**Files:**
- Modify: `src/index.ts` (multiple insertion points, all listed below with exact surrounding context)

**Interfaces:**
- Consumes: `HeartbeatStore`, `Heartbeat`, `startHeartbeatScheduler`, `parseHeartbeatInterval`, `PongStore` from `src/heartbeat.ts` (Tasks 1-2); `config.heartbeatsFile`/`config.pongFile` (this task adds `heartbeatsFile`, Task 3 already added `pongFile`); existing `deliverMessage`, `sessions.isWorking`, `complaints` (the existing `LoopComplaints` instance), `formatDuration` (already imported from `loops.js`).
- Produces: nothing consumed by later tasks — this is the final integration point.

**Step 4a: add `config.heartbeatsFile`**

- [ ] **Step 1: Modify `src/config.ts`**

Add immediately after the `pongFile` line Task 3 added:

```ts
  /** Where per-conversation /heartbeat schedules live. */
  heartbeatsFile: process.env.BROKER_HEARTBEATS_FILE ?? join(homedir(), '.claude-telegram-broker-heartbeats.json'),
```

**Step 4b: prompt text constants**

- [ ] **Step 2: Add to `src/heartbeat.ts`** (no test needed — these are string constants, covered indirectly by Task 4's `deliverHeartbeat` test below)

Append to `src/heartbeat.ts`:

```ts
/** Fixed prompt text — not user-configurable. This is a liveness check, not
 *  a second /loop; letting the user supply arbitrary text here would make it
 *  one, and the escalation message specifically needs to stay accurate about
 *  what it is asking the session to do. */
export const HEARTBEAT_PING_PROMPT =
  'Heartbeat check — no action needed, just let this turn end normally.';

export const HEARTBEAT_ESCALATED_PROMPT =
  'URGENT: Telegram communication appears broken — no reply reached the watching ' +
  'Telegram topic after the last heartbeat ping. Please investigate why the Stop hook ' +
  'mirror is not delivering (check settings.json hook paths, the broker daemon process, ' +
  'and TELEGRAM_BOT_TOKEN) and fix it now.';
```

**Step 4c: scheduler wiring, `deliverHeartbeat`, and commands**

- [ ] **Step 3: Write the failing test**

Check whether `index.ts`'s `deliverLoop`/command handlers have a dedicated test file (`ls test/ | grep -i index`, or check `test/loops.test.ts` and `test/stop-hook.test.ts` again for whether either already covers `index.ts` functions directly — `index.ts` is the entry point and may not be unit-tested at this granularity anywhere yet). If no such file exists, `deliverHeartbeat` is not independently testable without either exporting it from `index.ts` (mirroring Task 3's `mirrorReply` export) or extracting it. Given `index.ts` does not currently export `deliverLoop` for direct testing either (it is wired inline as a closure over `loops`/`complaints`), follow the same convention: **do not force a new test seam onto `index.ts` that the file's own existing pattern (`deliverLoop`) doesn't have.** This step's verification is Step 5 below (a real manual run), not a unit test — consistent with how `deliverLoop` itself has no dedicated unit test in this codebase today (confirm this by checking `test/loops.test.ts`'s `describe` blocks above: `parseDuration`, `formatDuration`, `LoopStore`, `LoopComplaints`, `startLoopScheduler` — no `deliverLoop`).

- [ ] **Step 4: Implement the wiring**

In `src/index.ts`, modify the import block. Find:

```ts
import { LoopComplaints, LoopStore, formatDuration, parseDuration, startLoopScheduler, type Loop } from './loops.js';
```

Add immediately after it:

```ts
import {
  HeartbeatStore,
  HEARTBEAT_ESCALATED_PROMPT,
  HEARTBEAT_PING_PROMPT,
  PongStore,
  parseHeartbeatInterval,
  startHeartbeatScheduler,
  type Heartbeat,
} from './heartbeat.js';
```

Find the `loops` instantiation near the top of the file:

```ts
const loops = new LoopStore(config.loopsFile);
```

Add immediately after it:

```ts
const heartbeats = new HeartbeatStore(config.heartbeatsFile);
const pongs = new PongStore(config.pongFile);
```

Find the help-text block (the array of strings printed for `/help`), specifically this section:

```ts
      '/loops — list this conversation’s scheduled loops',
      '/unloop <id> — cancel a loop',
      '/reloop <id> <interval> <prompt…> — replace a loop’s interval and prompt',
      '/mode [name] — show or change this session’s permission mode',
```

Insert between the `/reloop` line and the `/mode` line:

```ts
      '/loops — list this conversation’s scheduled loops',
      '/unloop <id> — cancel a loop',
      '/reloop <id> <interval> <prompt…> — replace a loop’s interval and prompt',
      '/heartbeat <interval> — periodically verify Telegram mirroring is alive,',
      '    e.g. /heartbeat 30m. Minimum 5m. Escalates to an urgent in-session',
      '    prompt if a ping goes unanswered.',
      '/heartbeats — show this conversation’s heartbeat, if any',
      '/unheartbeat — turn it off',
      '/mode [name] — show or change this session’s permission mode',
```

Find the end of the existing `/loop`-related block, right after `startLoopScheduler` is called and before the `/loop` command handler:

```ts
const loopScheduler = startLoopScheduler(loops, deliverLoop);

/**
 * `/loop <interval> <prompt…>` — schedule prompt to fire into this
 * conversation every interval, starting one interval from now.
 */
frontend.onCommand('loop', async (msg, args) => {
```

Insert the heartbeat delivery function and scheduler start immediately before that block (right after `const complaints = new LoopComplaints();` and its surrounding `deliverLoop` function, i.e. right before `const loopScheduler = startLoopScheduler(loops, deliverLoop);`):

```ts
/**
 * A due heartbeat, delivered with the same skip-while-working judgement
 * deliverLoop makes, plus the freshness check this feature exists for.
 *
 * Freshness: has a pong landed since the LAST ping this heartbeat sent? If
 * hb.lastPingAt is null (first ping ever) there is nothing to check yet —
 * ping normally. Otherwise compare pongs.lastPongAt(sessionId) against
 * hb.lastPingAt: a pong strictly after the last ping means that ping's turn
 * produced a real successful mirror, so the channel is alive. A missing or
 * stale pong means the last ping went unanswered — escalate.
 */
async function deliverHeartbeat(hb: Heartbeat): Promise<void> {
  if (sessions.isWorking(hb.conversationId)) {
    console.log(`[heartbeat] ${hb.conversationId} skipped: still working on the last one`);
    return;
  }

  const entry = registry.get(hb.conversationId);
  const sessionId = entry?.sessionId;

  let escalate = false;
  if (hb.lastPingAt !== null && sessionId) {
    const lastPong = pongs.lastPongAt(sessionId);
    escalate = lastPong === null || lastPong <= hb.lastPingAt;
  }

  const prompt = escalate ? HEARTBEAT_ESCALATED_PROMPT : HEARTBEAT_PING_PROMPT;
  const outcome = await deliverMessage(hb.conversationId, prompt);
  heartbeats.markPinged(hb.conversationId, escalate);

  // Delivery-failure reporting mirrors deliverLoop exactly (report once via
  // the shared LoopComplaints instance, keyed by conversationId since there
  // is only one heartbeat per conversation — no id to disambiguate several,
  // unlike a loop). The escalated PROMPT ITSELF (sent to Claude, inside the
  // session) is unrelated to this — this block is only about telling the
  // Telegram user the ping couldn't even be delivered at all (session not
  // listening / no quota), which needs the same "say it once" treatment a
  // loop's delivery failure gets.
  if (outcome.status === 'delivered') return;
  if (!complaints.shouldReport(`heartbeat:${hb.conversationId}`, outcome.status)) return;

  if (outcome.status === 'no-quota') {
    await frontend.sendText(
      hb.conversationId,
      `${blockedMessage(outcome.window, `Heartbeat couldn't ping.`)}\n` +
        `It keeps trying every ${formatDuration(hb.intervalMs)} and will say nothing more until it lands; ` +
        `/unheartbeat to stop it.`,
    );
    return;
  }

  await frontend.sendText(
    hb.conversationId,
    `💓 Heartbeat couldn't ping — nothing is listening in this watched session. ` +
      `It keeps trying every ${formatDuration(hb.intervalMs)} and will say nothing more until it lands; ` +
      `/unheartbeat to stop it.`,
  );
}

const heartbeatScheduler = startHeartbeatScheduler(heartbeats, deliverHeartbeat);
```

Then, after the existing `/reloop` command handler block (right after its closing `});`), add the three new commands:

```ts
/**
 * `/heartbeat <interval>` — periodically verify this conversation's Stop-hook
 * mirror is alive; escalates to an urgent in-session prompt on a miss.
 */
frontend.onCommand('heartbeat', async (msg, args) => {
  const intervalText = args.trim().split(/\s+/)[0] ?? '';
  if (!intervalText) {
    throw new Error('/heartbeat <interval> — e.g. /heartbeat 30m. Minimum 5m.\nManage it: /heartbeats, /unheartbeat');
  }
  const intervalMs = parseHeartbeatInterval(intervalText);
  const hb = heartbeats.enable(msg.conversationId, intervalMs);
  await frontend.sendText(
    msg.conversationId,
    `💓 Heartbeat set — checking every ${formatDuration(intervalMs)}, first check in ${formatDuration(intervalMs)}.\n/unheartbeat to cancel.`,
  );
});

frontend.onCommand('heartbeats', async (msg) => {
  const hb = heartbeats.get(msg.conversationId);
  if (!hb) {
    await frontend.sendText(msg.conversationId, 'No heartbeat in this conversation. /heartbeat <interval> to add one.');
    return;
  }
  const inMs = hb.nextPingAt - Date.now();
  const nextIn = inMs > 0 ? `next in ${formatDuration(inMs)}` : 'due now';
  const status = hb.escalated ? '⚠️ escalated — last ping went unanswered' : '✅ healthy';
  await frontend.sendText(msg.conversationId, `💓 every ${formatDuration(hb.intervalMs)} (${nextIn}) — ${status}`);
});

frontend.onCommand('unheartbeat', async (msg) => {
  if (!heartbeats.disable(msg.conversationId)) {
    throw new Error('No heartbeat in this conversation. /heartbeat <interval> to add one.');
  }
  complaints.forget(`heartbeat:${msg.conversationId}`);
  await frontend.sendText(msg.conversationId, '🛑 Heartbeat cancelled.');
});
```

- [ ] **Step 5: Manual verification (no automated test seam for this integration point, matching `deliverLoop`'s own precedent — see Step 3)**

Run: `npm run typecheck`
Expected: no errors.

Run: `npm test`
Expected: PASS — same pass/fail count as the end of Task 3 (this task adds no new test files, only wiring).

Then a real manual smoke check against the running daemon (adjust the conversation id to a real watched one from `~/.claude-telegram-broker.json`):
1. Start the daemon: `npm start` (or however it's normally run in this environment — check `broker_pid.txt`/existing running-daemon convention first, do not start a second instance alongside one already running).
2. From that conversation's Telegram topic (or by directly invoking the command handler in a scratch script if Telegram access isn't available in this environment), send `/heartbeat 5m`.
3. Confirm the reply: `💓 Heartbeat set — checking every 5m, first check in 5m.`
4. Send `/heartbeats` — confirm it shows `✅ healthy` (no ping has happened yet, so `hb.lastPingAt` is `null`, so `deliverHeartbeat`'s escalate check is skipped and nothing has flagged it unhealthy).
5. Send `/unheartbeat` — confirm `🛑 Heartbeat cancelled.` and a follow-up `/heartbeats` says `No heartbeat in this conversation.`

Expected: all three commands behave as described. This step is the plan's real acceptance check for the integration point Step 3 above explained has no automated seam — do not skip it.

- [ ] **Step 6: Commit**

```bash
git add src/config.ts src/heartbeat.ts src/index.ts
git commit -m "feat(heartbeat): wire scheduler and /heartbeat, /heartbeats, /unheartbeat commands"
```

---

## Self-Review

**Spec coverage:**
- `HeartbeatStore`/`PongStore` exact shapes — Tasks 1-2. ✅
- `stop-hook.ts`'s `recordPong` call after successful send — Task 3. ✅
- Scheduler + delivery + escalation logic + `LoopComplaints` reuse — Task 4. ✅
- `/heartbeat`/`/heartbeats`/`/unheartbeat` commands — Task 4. ✅
- Fixed prompt text constants — Task 4b. ✅
- 5-minute floor, distinct from `loops.ts` — Task 2. ✅
- Escalation persists every tick until a pong lands (not "report once") — Task 4's `deliverHeartbeat` re-evaluates `escalate` fresh on every call from `hb.lastPingAt`/`pongs.lastPongAt`, so it naturally keeps escalating without needing separate state beyond what's already there. ✅
- Naming-collision documentation vs. `mirror.ts`'s `heartbeatFresh` — Global Constraints + Task 1's file-header doc comment. ✅
- Test plan (`heartbeat.test.ts`, `stop-hook.test.ts` additions) — Tasks 1-3. Task 4's `index.ts` wiring has no automated test per the codebase's own existing precedent (documented explicitly in Task 4 rather than silently skipped). ✅

**Placeholder scan:** no TBD/TODO markers; the two explicit "implementer's call" notes (Task 3's `send`-mocking fallback, Task 4's no-test-seam-for-index.ts) are documented engineering judgment calls with a concrete fallback given, not open placeholders.

**Type consistency:** `Heartbeat`, `HeartbeatStore`, `PongStore`, `PongRecord` are defined once in Task 1/2 and referenced identically (same names, same shapes) in Tasks 3 and 4. `mirrorReply`'s signature (`conversationId, sessionId, text`) is introduced in Task 3 and not referenced elsewhere. `deliverHeartbeat`/`startHeartbeatScheduler`'s callback shape (`(hb: Heartbeat) => Promise<void>`) matches between Task 2's `startHeartbeatScheduler` signature and Task 4's `deliverHeartbeat` definition.

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-07-18-heartbeat-implementation.md`. Two execution options:

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints.

Which approach?

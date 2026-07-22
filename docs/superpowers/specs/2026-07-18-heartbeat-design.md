# Heartbeat (session↔Telegram liveness check) — Design

> **For agentic workers:** REQUIRED SUB-SKILL: use superpowers:writing-plans to turn this into an implementation plan.

## Goal

An optional, per-conversation, `/loop`-shaped mechanism that periodically verifies the
Stop-hook mirror (session → Telegram) is actually alive, and — when it isn't — injects an
urgent, plain-English prompt into the live session telling it to investigate and fix the
broken communication channel.

## Why

The Stop-hook auto-mirror has been confirmed intermittent in real use. The daemon (which
owns `/loop`, `/watch`, and all inbound Telegram traffic) has no visibility into whether a
given Stop-hook invocation actually reached Telegram, because `stop-hook.ts` talks to
Telegram's Bot API directly and never touches the running daemon process — the two only
share a state file on disk. This feature closes that visibility gap.

## Architecture

Two new files plus one small addition to an existing one, following the `/loop` pattern
(`loops.ts` + the `deliverLoop`/`startLoopScheduler` wiring in `index.ts`) as closely as
possible rather than inventing new plumbing.

### `src/heartbeat.ts` (new)

Two responsibilities, mirroring `loops.ts`'s `LoopStore` / `LoopComplaints` split:

**`HeartbeatStore`** — persists per-conversation heartbeat config, same atomic
temp-file-then-rename write pattern as `LoopStore`:

```ts
export type Heartbeat = {
  conversationId: string;
  intervalMs: number;
  nextPingAt: number;
  lastPingAt: number | null;
  escalated: boolean; // true once a ping has gone unanswered — next ping is urgent
};
```

One heartbeat per conversation (unlike loops, which allow several) — enabling a second
`/heartbeat` call on an already-heartbeating conversation replaces the existing one
(same UX as `/reloop`, just implicit rather than requiring an id).

`enable(conversationId, intervalMs)`, `disable(conversationId)`, `get(conversationId)`,
`takeDue(now)` (same contract as `LoopStore.takeDue`: due entries returned, each
rescheduled for `now + intervalMs` before returning).

Reuses `parseDuration`/`formatDuration` from `loops.ts` for interval parsing, but with
its own, higher floor: `MIN_HEARTBEAT_INTERVAL_MS = 5 * 60_000` (5 minutes), not
`loops.ts`'s `MIN_INTERVAL_MS` (1 minute). A heartbeat ping consumes a real turn every
time it fires (unlike a loop, which is opt-in per use case) — 1-minute pings would burn
tokens fast on a channel that's supposed to be a lightweight liveness check.
`parseDuration` takes the floor as a parameter for this reason (or, if that's a larger
change than warranted, `heartbeat.ts` validates the floor itself after calling
`parseDuration` — implementer's call, either is fine as long as `/heartbeat 2m` is
rejected with a clear error the same way `/loop 45s` already is).

**`PongStore`** — the pong-marker file `stop-hook.ts` writes to and the heartbeat
scheduler reads from. Deliberately its own small file/module, not folded into
`HeartbeatStore`, because it has a different writer (a short-lived `stop-hook.ts`
process, once per turn) and a different reader (the long-lived daemon) — conflating them
would mean the daemon's periodic `flush()` calls (from ping scheduling) and
`stop-hook.ts`'s one-shot write race on the same file.

```ts
export type PongRecord = { sessionId: string; lastPongAt: number };
```

`recordPong(sessionId)` — called from `stop-hook.ts` after a successful
`send()` in `mirrorReply`, nowhere else (a `no-quota` or `not-listening` loop delivery
is not evidence the mirror pipeline works — only a real successful Telegram send is).

`lastPongAt(sessionId): number | null` — read side, used by the heartbeat scheduler.

### `stop-hook.ts` (small addition)

One call added inside `mirrorReply`, immediately after the `send()` loop completes
without throwing:

```ts
await recordPong(sessionId);
```

No other behavior in this file changes. `sessionId` is already in scope (the function's
caller has it). This is the entire footprint of the fix in the file that's actually
flaky — everything else lives in the new module and the scheduler wiring below.

### `index.ts` (scheduler wiring, mirrors the existing `/loop` block)

- `const heartbeats = new HeartbeatStore(config.heartbeatsFile);` (new config path,
  same convention as `config.loopsFile`).
- `deliverHeartbeat(hb: Heartbeat)`: same `sessions.isWorking()` skip-guard `deliverLoop`
  uses (a mid-turn session isn't a communication failure — don't queue a ping behind a
  turn that's already running). Reads `PongStore.lastPongAt(sessionId)`; if it's `null`
  or older than `hb.lastPingAt`, this ping is a *miss* for the previous ping — set
  `escalated = true` and use the urgent prompt text; otherwise ping succeeded, reset
  `escalated = false` and use the normal prompt text. Then call the same
  `deliverMessage(hb.conversationId, promptText)` `/loop` uses, so a heartbeat ping is
  indistinguishable from a typed message the same way a loop prompt is (watched-session
  inbox routing included, `not-listening`/`no-quota` handling included for free).
- `startLoopScheduler`-shaped `startHeartbeatScheduler(store, deliver)`: identical
  30-second tick, due-item, reschedule-before-return shape — copy the pattern, don't
  generalize `startLoopScheduler` to cover both (they have different due-item shapes
  and reusing one generic function for two call sites this small would cost more
  clarity than it saves).
- `/heartbeat <interval>`, `/heartbeats`, `/unheartbeat` commands, directly mirroring
  `/loop`/`/loops`/`/unloop`'s existing implementations minus the `<prompt…>` argument
  (the prompt text is fixed, not user-supplied — this isn't a general scheduler, it's a
  liveness check with two fixed messages).

### Prompt text (fixed constants in `heartbeat.ts`, not user-configurable)

```
Normal ping:
"Heartbeat check — no action needed, just let this turn end normally."

Escalated (sent once a ping has gone unanswered, and every ping after until a pong
lands again):
"URGENT: Telegram communication appears broken — no reply reached the watching
Telegram topic after the last heartbeat ping. Please investigate why the Stop hook
mirror is not delivering (check settings.json hook paths, the broker daemon process,
and TELEGRAM_BOT_TOKEN) and fix it now."
```

## Data flow

```
scheduler tick (30s)
  -> HeartbeatStore.takeDue()
  -> for each due heartbeat:
       skip if sessions.isWorking(conversationId)
       check PongStore.lastPongAt(sessionId) against hb.lastPingAt
         -> stale/missing: escalated=true, use urgent prompt
         -> fresh: escalated=false, use normal prompt
       deliverMessage(conversationId, prompt)   // same path /loop uses
       hb.lastPingAt = now

(separately, every real turn, whether triggered by a heartbeat ping or not)
Stop hook fires -> mirrorReply sends to Telegram -> on success -> recordPong(sessionId)
```

The mechanism doesn't require the ping prompt's reply to say anything special — *any*
successful Stop-hook mirror after a ping was sent counts as a pong, because the thing
being tested is "does this session's Stop hook reach Telegram at all," not "did it
answer this specific message." A heartbeat ping just guarantees at least one real turn
happens inside the interval to produce that evidence, even during a quiet stretch where
nothing else would.

## Error handling

- `PongStore` read/write failures degrade the same way `LoopStore`/`broker-state.ts`
  already do elsewhere in this codebase: caught, logged, treated as "no data" rather
  than crashing the scheduler tick.
- A heartbeat pointed at a session with nothing listening (`not-listening` from
  `deliverMessage`) is reported the same way `deliverLoop` already reports it — once,
  via `LoopComplaints` (reused as-is, keyed by a synthetic id derived from the
  conversationId since there's one heartbeat per conversation, not several by id).
- `no-quota` handling: identical to `deliverLoop` — report once via `LoopComplaints`,
  keep retrying every interval, no special heartbeat behavior.
- The escalated prompt does **not** consult `LoopComplaints` — unlike a delivery
  failure (which the user needs to hear about once), the escalation is a message *to
  Claude*, delivered into the session every interval until a pong lands, matching the
  "keep nudging until actually fixed" intent explicit in the request, not the
  "say it once, then go quiet" intent `LoopComplaints` exists for.

## Testing

- `heartbeat.test.ts`: `HeartbeatStore` (enable/disable/get/takeDue, atomic write) and
  `PongStore` (recordPong/lastPongAt, atomic write) as pure unit tests, same shape as
  `loops.test.ts`'s existing `LoopStore` coverage.
- A `deliverHeartbeat`-level test (in `index.test.ts` or a new `heartbeat-delivery.test.ts`,
  matching wherever `deliverLoop` is currently tested) covering: fresh pong → normal
  prompt; stale/missing pong → escalated prompt; working session → skipped; escalation
  persists across consecutive misses.
- `stop-hook.test.ts`: assert `recordPong` is called after a successful send and NOT
  called when `send()` throws or when the session isn't watched at all.

## Out of scope (explicitly not building)

- User-supplied ping/escalation prompt text — these are fixed, this is a liveness
  check, not a second `/loop`.
- Any attempt to detect *why* the mirror is broken from inside the heartbeat itself —
  it delegates that entirely to the injected prompt, which asks the session (with full
  tool access) to actually diagnose and fix it, rather than trying to encode diagnosis
  logic in the scheduler.
- Cross-conversation heartbeats or a global on/off switch — strictly per-conversation,
  opt-in, matching how `/loop` already works.

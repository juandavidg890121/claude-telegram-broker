import { randomBytes } from 'node:crypto';
import {
  closeSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { HEARTBEAT_STALE_MS, MIRROR_ROOT, mirrorDir } from './mirror.js';

/**
 * The file handoff behind an answered AskUserQuestion in a *watched* session.
 *
 * A sibling of the /watch inbox, and for the same reason it exists at all:
 * Telegram's getUpdates admits exactly one poller per token, and the broker owns
 * it. The PreToolUse hook fires inside someone else's Claude Code process, so it
 * cannot listen for the button tap itself — it can only leave the question
 * somewhere the broker will find it, and wait for the answer to come back.
 *
 * The direction is the mirror image of the inbox: there, Telegram writes and the
 * session reads; here, the session writes and Telegram answers.
 *
 * Broker-owned sessions (/new, /fork) never touch any of this. There the
 * question arrives on canUseTool, in the broker's own process, so it awaits a
 * promise instead of a file.
 */

export const asksDir = (sessionId: string): string => join(mirrorDir(sessionId), 'asks');

/**
 * Seconds a question waits for a tap. Lives here rather than in config.ts
 * because all three of the things that need it — the broker, the hook, and the
 * installer that writes the hook's own `timeout` — must agree on one number, and
 * only the broker can satisfy config.ts's startup contract.
 */
export const ASK_TIMEOUT_SEC = Number(process.env.BROKER_ASK_TIMEOUT_SEC ?? 600);

/**
 * The broker's own liveness, distinct from the per-session heartbeat in
 * mirror.ts and load-bearing in a way that one is not.
 *
 * The session heartbeat answers "is anything listening in that session"; this
 * answers "is anyone going to pick this question up". Without it the hook has no
 * way to tell a broker that is thinking from one that is not running, so it
 * would block the real session for the full timeout before falling back — a
 * stopped broker would turn every question in every watched session into a
 * ten-minute stall. Checking first makes that case instant instead.
 */
export const brokerHeartbeatPath = (): string => join(MIRROR_ROOT, 'broker-heartbeat');

export function touchBrokerHeartbeat(): void {
  mkdirSync(MIRROR_ROOT, { recursive: true });
  const path = brokerHeartbeatPath();
  try {
    const now = new Date();
    utimesSync(path, now, now);
  } catch {
    closeSync(openSync(path, 'w'));
  }
}

export function brokerAlive(now: number = Date.now()): boolean {
  try {
    return now - statSync(brokerHeartbeatPath()).mtimeMs < HEARTBEAT_STALE_MS;
  } catch {
    return false;
  }
}

/** One question, as AskUserQuestion poses it. Mirrors the SDK's own shape. */
export type AskQuestion = {
  question: string;
  header?: string;
  multiSelect?: boolean;
  options: { label: string; description?: string }[];
};

/**
 * Answers, keyed by the *question text* — not by index.
 *
 * That is the harness's own contract, not a choice made here: filling this in
 * and letting the tool run is what produces the native `Your questions have been
 * answered: "…"="…"` result, and it is looked up by question string. Keying by
 * index would produce a payload the tool ignores, which looks exactly like the
 * question never being answered.
 */
export type AskAnswers = Record<string, string>;

export type AskRequest = {
  id: string;
  sessionId: string;
  questions: AskQuestion[];
  /** ISO timestamp. */
  at: string;
  /** Epoch ms after which the hook has stopped waiting. */
  expiresAt: number;
};

export type AskAnswer = { id: string; answers: AskAnswers; at: string };

const requestFile = (sessionId: string, id: string): string => join(asksDir(sessionId), `${id}.request.json`);
const claimedFile = (sessionId: string, id: string): string => join(asksDir(sessionId), `${id}.claimed.json`);
const answerFile = (sessionId: string, id: string): string => join(asksDir(sessionId), `${id}.answer.json`);

export const newAskId = (): string => randomBytes(6).toString('hex');

/** Write `data` so it is never observed half-written. Same tmp+rename as the inbox. */
function writeAtomic(path: string, data: unknown): void {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(data));
  renameSync(tmp, path);
}

/** Hook side: leave a question for the broker to put on the phone. */
export function writeAskRequest(request: AskRequest): void {
  mkdirSync(asksDir(request.sessionId), { recursive: true });
  writeAtomic(requestFile(request.sessionId, request.id), request);
}

/**
 * Broker side: take ownership of every unclaimed question for this session.
 *
 * The rename is the claim and it happens before the read, exactly as in the
 * inbox: whoever renames owns it, everyone else gets ENOENT. Two brokers running
 * by accident is the case this defends against — without it both would send the
 * same question to the same topic and race to answer it.
 *
 * Expired requests are claimed and dropped rather than skipped, so a question
 * whose hook already gave up does not get pushed to a phone that can no longer
 * do anything with it.
 */
export function claimAskRequests(sessionId: string, now: number = Date.now()): AskRequest[] {
  const dir = asksDir(sessionId);
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return []; // No asks directory yet: this session has never asked anything.
  }

  const claimed: AskRequest[] = [];
  for (const name of names.filter((n) => n.endsWith('.request.json')).sort()) {
    const id = name.slice(0, -'.request.json'.length);
    try {
      renameSync(join(dir, name), claimedFile(sessionId, id));
    } catch {
      continue; // Another broker claimed it first.
    }
    try {
      const request = JSON.parse(readFileSync(claimedFile(sessionId, id), 'utf8')) as AskRequest;
      if (request.expiresAt > now) claimed.push(request);
      else clearAsk(sessionId, id);
    } catch {
      // Unparseable: already out of the way, so it cannot wedge the directory.
      clearAsk(sessionId, id);
    }
  }
  return claimed;
}

/** Broker side: publish the answer the human tapped. */
export function writeAskAnswer(sessionId: string, id: string, answers: AskAnswers): void {
  mkdirSync(asksDir(sessionId), { recursive: true });
  writeAtomic(answerFile(sessionId, id), { id, answers, at: new Date().toISOString() } satisfies AskAnswer);
}

/** Hook side: has the broker answered yet? */
export function readAskAnswer(sessionId: string, id: string): AskAnswers | undefined {
  try {
    return (JSON.parse(readFileSync(answerFile(sessionId, id), 'utf8')) as AskAnswer).answers;
  } catch {
    return undefined;
  }
}

/**
 * Is this question still worth answering?
 *
 * The broker checks this when a button is tapped, because the tap can easily
 * arrive after the hook gave up — the phone was in a pocket. Both files gone
 * means the hook cleaned up and moved on.
 */
export function askIsOpen(sessionId: string, id: string): boolean {
  for (const path of [requestFile(sessionId, id), claimedFile(sessionId, id)]) {
    try {
      statSync(path);
      return true;
    } catch {
      // Try the other one.
    }
  }
  return false;
}

/** Remove every trace of one question. Called by the hook once it is done with it. */
export function clearAsk(sessionId: string, id: string): void {
  for (const path of [requestFile(sessionId, id), claimedFile(sessionId, id), answerFile(sessionId, id)]) {
    rmSync(path, { force: true });
  }
}

/**
 * Broker side: poll every watched session for questions and put them on the
 * phone.
 *
 * Polling rather than fs.watch because the set of directories to watch changes
 * every time someone runs /watch or /stop, and re-registering watchers on
 * registry churn is materially more code than one readdir per watched session
 * per tick — of which there are a handful, not thousands.
 *
 * `answer` is handed the whole request so a frontend can say which session is
 * asking. It resolves undefined when nobody answered, and this writes nothing in
 * that case: the hook's own deadline is the authority on when to give up, and a
 * written "no answer" would race with it.
 */
export function startAskWatcher(
  watchedSessions: () => string[],
  answer: (request: AskRequest) => Promise<AskAnswers | undefined>,
  intervalMs = 500,
): ReturnType<typeof setInterval> {
  const inFlight = new Set<string>();

  const tick = (): void => {
    touchBrokerHeartbeat();
    for (const sessionId of watchedSessions()) {
      for (const request of claimAskRequests(sessionId)) {
        if (inFlight.has(request.id)) continue;
        inFlight.add(request.id);
        void answer(request)
          .then((answers) => {
            // Still open, or the hook already gave up and cleaned house? Writing
            // into a closed ask would leave a file nobody ever reads.
            if (answers && askIsOpen(sessionId, request.id)) {
              writeAskAnswer(sessionId, request.id, answers);
            }
          })
          .catch((error: unknown) => {
            console.error(`[asks] ${request.id}: ${error instanceof Error ? error.message : String(error)}`);
          })
          .finally(() => inFlight.delete(request.id));
      }
    }
  };

  tick();
  return setInterval(tick, intervalMs);
}

/**
 * Hook side: block until the broker answers, or the deadline passes.
 *
 * Polling rather than fs.watch on purpose. This runs in a short-lived process
 * whose only job is to wait, so there is nothing to be efficient about, and
 * fs.watch's platform differences are a poor trade for saving a few hundred
 * stat() calls. The poller in the watched session makes the same call for the
 * same reason.
 */
export async function waitForAnswer(
  sessionId: string,
  id: string,
  expiresAt: number,
  pollMs = 400,
): Promise<AskAnswers | undefined> {
  while (Date.now() < expiresAt) {
    const answers = readAskAnswer(sessionId, id);
    if (answers) return answers;
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  return readAskAnswer(sessionId, id);
}

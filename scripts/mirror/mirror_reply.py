"""Stop hook: mirror this turn's final assistant reply out to Telegram.

Only fires while watcher.json exists (written by watcher_start.py at
SessionStart, removed by watcher_end.py at SessionEnd) -- i.e. only for a
live-mirrored session, never for unrelated Claude Code sessions on this
machine.

Where to send it is looked up, not hardcoded: the broker's own state file
(the same JSON /resume writes to) already has the one authoritative mapping
of conversationId -> sessionId for every mirrored conversation. This script
just finds the entry whose sessionId matches *this* session and mirror is
true, and sends there. A session can be mirrored to at most one Telegram
topic at a time this way; if none matches, it sends nowhere and exits quietly
-- an unmirrored session producing no Telegram traffic is correct, not a bug.
"""
import json
import os
import sys
import urllib.request
from pathlib import Path

WATCHER_PATH = Path.home() / ".claude" / "telegram_mirror" / "watcher.json"
# Same env var name the broker itself uses (see src/config.ts) -- one token,
# one source of truth. sendMessage has no getUpdates-style single-consumer
# limit, so sharing the token between the broker's poller and this script is
# safe; only *reading* updates is exclusive, not sending them.
BOT_TOKEN = os.environ.get("TELEGRAM_BOT_TOKEN", "")
BROKER_STATE_FILE = os.environ.get(
    "BROKER_STATE_FILE", str(Path.home() / ".claude-telegram-broker.json")
)
MAX_LEN = 4000


def find_conversation(session_id: str) -> tuple[str, int | None] | None:
    """(chat_id, message_thread_id) for the Telegram conversation mirroring
    this session_id, or None if it isn't currently mirrored anywhere."""
    try:
        entries = json.loads(Path(BROKER_STATE_FILE).read_text(encoding="utf-8"))
    except Exception:
        return None
    for entry in entries:
        if entry.get("sessionId") == session_id and entry.get("mirror"):
            chat_id, _, thread = entry["conversationId"].partition(":")
            thread_id = int(thread) if thread and thread != "0" else None
            return chat_id, thread_id
    return None


def last_assistant_text(transcript_path: str) -> str:
    with open(transcript_path, "r", encoding="utf-8") as f:
        lines = f.readlines()
    for line in reversed(lines):
        line = line.strip()
        if not line:
            continue
        try:
            record = json.loads(line)
        except Exception:
            continue
        if record.get("type") != "assistant":
            continue
        content = record.get("message", {}).get("content", [])
        blocks = [b.get("text", "") for b in content if isinstance(b, dict) and b.get("type") == "text"]
        text = "\n".join(b for b in blocks if b).strip()
        if text:
            return text
    return ""


def chunkify(text: str) -> list[str]:
    chunks = []
    rest = text
    while len(rest) > MAX_LEN:
        cut = rest.rfind("\n", 0, MAX_LEN)
        at = cut if cut > MAX_LEN // 2 else MAX_LEN
        chunks.append(rest[:at])
        rest = rest[at:]
    if rest.strip():
        chunks.append(rest)
    return chunks


def send(chat_id: str, thread_id: int | None, chunk: str) -> None:
    url = f"https://api.telegram.org/bot{BOT_TOKEN}/sendMessage"
    body = {"chat_id": chat_id, "text": chunk}
    if thread_id is not None:
        body["message_thread_id"] = thread_id
    data = json.dumps(body).encode("utf-8")
    req = urllib.request.Request(url, data=data, headers={"Content-Type": "application/json"})
    urllib.request.urlopen(req, timeout=10).read()


def main() -> None:
    if not BOT_TOKEN or not WATCHER_PATH.exists():
        return
    try:
        payload = json.load(sys.stdin)
    except Exception:
        return

    session_id = payload.get("session_id")
    transcript_path = payload.get("transcript_path")
    if not session_id or not transcript_path:
        return

    target = find_conversation(session_id)
    if target is None:
        return
    chat_id, thread_id = target

    text = last_assistant_text(transcript_path)
    if not text:
        return

    for chunk in chunkify(text):
        try:
            send(chat_id, thread_id, chunk)
        except Exception:
            pass  # best-effort mirror -- never break the actual session over a Telegram hiccup


if __name__ == "__main__":
    main()

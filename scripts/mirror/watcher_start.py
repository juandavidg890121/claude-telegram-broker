"""SessionStart hook: mark this session as the live watcher for the Telegram
mirror, and ask the model to arm the poller that keeps it alive.

Writing watcher.json only establishes identity (which session, which
directory) -- it says nothing about whether the session is still running a
minute from now. That's the poller's job (mirror-poller.sh): it touches a
heartbeat file every second and claims inbox messages. This hook can't run
that loop itself -- it's a one-shot subprocess that exits immediately, not
something that lives as long as the session -- so instead it hands the model
an instruction, via additionalContext, to arm it as a background Monitor.
"""
import json
import os
import sys
from pathlib import Path

MIRROR_DIR = Path.home() / ".claude" / "telegram_mirror"
WATCHER_PATH = MIRROR_DIR / "watcher.json"
POLLER_PATH = Path(__file__).resolve().parent / "mirror-poller.sh"


def main() -> None:
    try:
        payload = json.load(sys.stdin)
    except Exception:
        payload = {}

    session_id = payload.get("session_id", "")
    cwd = payload.get("cwd", os.getcwd())

    MIRROR_DIR.mkdir(parents=True, exist_ok=True)
    watcher = {"pid": os.getppid(), "session_id": session_id, "cwd": cwd}
    WATCHER_PATH.write_text(json.dumps(watcher), encoding="utf-8")

    print(json.dumps({
        "hookSpecificOutput": {
            "hookEventName": "SessionStart",
            "additionalContext": (
                "This session can be watched from Telegram via the claude-telegram-broker "
                "plugin's /resume. For it to actually work, arm a background Monitor now:\n"
                f'  command: "bash \\"{POLLER_PATH}\\""\n'
                "  description: \"Telegram mirror poller (heartbeat + inbox claim)\"\n"
                "  persistent: true\n"
                "Skip this if a Monitor for this exact command is already armed this session."
            ),
        }
    }))


if __name__ == "__main__":
    main()

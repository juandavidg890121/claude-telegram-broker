"""SessionEnd hook: clear the watcher marker so the broker knows this session
is gone immediately, rather than waiting on the heartbeat to go stale.
"""
import os
from pathlib import Path

WATCHER_PATH = Path.home() / ".claude" / "telegram_mirror" / "watcher.json"


def main() -> None:
    try:
        os.remove(WATCHER_PATH)
    except FileNotFoundError:
        pass


if __name__ == "__main__":
    main()

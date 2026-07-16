#!/usr/bin/env bash
# Runs as the Monitor command on the mirrored (VS Code) side of /resume.
#
# Each loop iteration does two things:
#   1. Touches `heartbeat` -- the broker measures its mtime to decide whether
#      this session is still alive. No pid involved: if this loop stops (the
#      session crashed, was closed, whatever), the heartbeat simply goes stale
#      within a few seconds and the broker falls back to driving the session
#      headlessly. Nothing to leak, nothing that can point at a reused pid.
#   2. Claims the oldest pending message in inbox/, if any, by renaming it into
#      processed/ -- an atomic move on the same volume on both POSIX and
#      Windows, so there is never a window where two readers could take the
#      same file. Only the file that got successfully moved gets printed;
#      Monitor treats each printed line as one event delivered into this
#      session.
#
# Usage: mirror-poller.sh [mirror-dir]
# Defaults to ~/.claude/telegram_mirror, matching watcher_start.py/mirror_reply.py.

set -u

MIRROR_DIR="${1:-$HOME/.claude/telegram_mirror}"
INBOX_DIR="$MIRROR_DIR/inbox"
PROCESSED_DIR="$MIRROR_DIR/processed"
HEARTBEAT_PATH="$MIRROR_DIR/heartbeat"

mkdir -p "$INBOX_DIR" "$PROCESSED_DIR"

while true; do
  touch "$HEARTBEAT_PATH"

  for f in "$INBOX_DIR"/*.json; do
    [ -e "$f" ] || continue
    content=$(cat "$f")
    base=$(basename "$f")
    # If the rename fails, something else already claimed this file -- skip it
    # rather than print a message twice.
    mv "$f" "$PROCESSED_DIR/$base" 2>/dev/null || continue
    echo "$content"
  done

  sleep 1
done

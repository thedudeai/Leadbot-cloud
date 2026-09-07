#!/bin/sh
# Railway mounts the volume as root, so a container that starts as the app user
# cannot write to /data. Start as root, hand the volume to leadbot, then drop
# privileges for the real process (Claude Code refuses to bypass permissions as root).
set -e
DIR="${DATA_DIR:-/data}"
mkdir -p "$DIR"
chown -R leadbot:leadbot "$DIR"
exec setpriv --reuid=leadbot --regid=leadbot --init-groups "$@"

#!/bin/zsh
set -euo pipefail

CONFIG_FILE=""
INSTANCE_NAME="${INSTANCE_NAME:-}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --config)
      CONFIG_FILE="$2"
      shift 2
      ;;
    --instance)
      INSTANCE_NAME="$2"
      shift 2
      ;;
    *)
      echo "Unknown argument: $1" >&2
      exit 1
      ;;
  esac
done

if [[ -n "$CONFIG_FILE" ]]; then
  CONFIG_DIR="$(dirname "$CONFIG_FILE")"
  if [[ -d "$CONFIG_DIR" ]]; then
    CONFIG_DIR="$(cd "$CONFIG_DIR" && pwd)"
  fi
  CONFIG_FILE="$CONFIG_DIR/$(basename "$CONFIG_FILE")"
  if [[ -z "$INSTANCE_NAME" ]]; then
    INSTANCE_NAME="$(basename "$(dirname "$CONFIG_FILE")")"
  fi
fi

if [[ -z "$INSTANCE_NAME" ]]; then
  INSTANCE_NAME="default"
fi

PLIST_NAME="${PLIST_NAME:-com.codex.telegram-bridge.$INSTANCE_NAME}"
TARGET_PLIST="$HOME/Library/LaunchAgents/$PLIST_NAME.plist"

launchctl unload "$TARGET_PLIST" >/dev/null 2>&1 || true
rm -f "$TARGET_PLIST"

echo "Removed launch agent: $TARGET_PLIST"

#!/bin/zsh
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
NODE_BIN="${NODE_BIN:-$(command -v node)}"

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

if [[ -z "$CONFIG_FILE" ]]; then
  if [[ -z "$INSTANCE_NAME" ]]; then
    INSTANCE_NAME="default"
  fi
  CONFIG_FILE="$HOME/.codex-telegram-bridge/instances/$INSTANCE_NAME/config.env"
fi

CONFIG_DIR="$(dirname "$CONFIG_FILE")"
if [[ -d "$CONFIG_DIR" ]]; then
  CONFIG_DIR="$(cd "$CONFIG_DIR" && pwd)"
fi
CONFIG_FILE="$CONFIG_DIR/$(basename "$CONFIG_FILE")"
INSTANCE_ROOT="${INSTANCE_ROOT:-$CONFIG_DIR}"
if [[ -z "$INSTANCE_NAME" ]]; then
  INSTANCE_NAME="$(basename "$INSTANCE_ROOT")"
fi

PLIST_NAME="${PLIST_NAME:-com.codex.telegram-bridge.$INSTANCE_NAME}"
TARGET_DIR="$HOME/Library/LaunchAgents"
TARGET_PLIST="$TARGET_DIR/$PLIST_NAME.plist"
LOG_DIR="${LOG_DIR:-$INSTANCE_ROOT/logs}"

mkdir -p "$TARGET_DIR" "$LOG_DIR"

if [[ ! -f "$CONFIG_FILE" ]]; then
  echo "Config file not found: $CONFIG_FILE" >&2
  echo "Create it from $PROJECT_ROOT/config.env.example first." >&2
  exit 1
fi

if [[ ! -f "$PROJECT_ROOT/dist/index.js" ]]; then
  echo "dist/index.js not found, building first..."
  (cd "$PROJECT_ROOT" && npm run build)
fi

cat > "$TARGET_PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>$PLIST_NAME</string>

    <key>ProgramArguments</key>
    <array>
      <string>$NODE_BIN</string>
      <string>$PROJECT_ROOT/dist/index.js</string>
      <string>--config</string>
      <string>$CONFIG_FILE</string>
    </array>

    <key>WorkingDirectory</key>
    <string>$PROJECT_ROOT</string>

    <key>RunAtLoad</key>
    <true/>

    <key>KeepAlive</key>
    <true/>

    <key>StandardOutPath</key>
    <string>$LOG_DIR/bridge.stdout.log</string>

    <key>StandardErrorPath</key>
    <string>$LOG_DIR/bridge.stderr.log</string>

    <key>EnvironmentVariables</key>
    <dict>
      <key>NODE_ENV</key>
      <string>production</string>
    </dict>
  </dict>
</plist>
PLIST

launchctl unload "$TARGET_PLIST" >/dev/null 2>&1 || true
launchctl load "$TARGET_PLIST"

echo "Installed launch agent: $TARGET_PLIST"
echo "Config file: $CONFIG_FILE"
echo "Logs: $LOG_DIR"
echo "Use 'launchctl list | rg $PLIST_NAME' to inspect it."

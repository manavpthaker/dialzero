#!/bin/bash
# Verify Node resolution from the same PATH configured for Assistant's launchd
# agent. This intentionally avoids shell startup files: launchd never reads
# ~/.zshrc, ~/.zprofile, nvm, or fnm configuration.
set -euo pipefail

PLIST_PATH="${1:-$HOME/Library/LaunchAgents/${LAUNCHD_LABEL_PREFIX:-dev.dialzero}.agent.plist}"

if [[ ! -f "$PLIST_PATH" ]]; then
  echo "Assistant launchd plist not found: $PLIST_PATH" >&2
  exit 1
fi

LAUNCHD_PATH="$(/usr/libexec/PlistBuddy -c 'Print :EnvironmentVariables:PATH' "$PLIST_PATH" 2>/dev/null)" || {
  echo "No EnvironmentVariables.PATH in $PLIST_PATH" >&2
  exit 1
}

echo "plist: $PLIST_PATH"
echo "launchd PATH: $LAUNCHD_PATH"
env -i PATH="$LAUNCHD_PATH" /bin/sh -c '
  resolved="$(command -v node)"
  echo "node: $resolved"
  exec node --version
'

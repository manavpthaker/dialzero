#!/usr/bin/env bash
# Nightly backup of the SQLite database using SQLite's online backup API.
# Safe against concurrent writes from the always-running agent.
# Driven by launchd/templates/backup.plist.tmpl at 03:00 local time
# (installed by npm run install:service).
#
# The database path matches src/db.ts: ASSISTANT_DB_PATH, else assistant.db in
# the repo this script lives in. The launchd job loads .env first, so a
# ASSISTANT_DB_PATH set there is honored.

set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DB="${ASSISTANT_DB_PATH:-${REPO_DIR}/assistant.db}"
BACKUP_DIR="${HOME}/assistant-backups"
RETAIN_DAYS=14

mkdir -p "${BACKUP_DIR}"

if [[ ! -f "${DB}" ]]; then
  echo "[backup] database not found at ${DB}" >&2
  exit 1
fi

STAMP="$(date '+%Y%m%d-%H%M%S')"
TARGET="${BACKUP_DIR}/assistant.db.${STAMP}"

# .backup uses SQLite's online backup API — torn-write safe.
/usr/bin/sqlite3 "${DB}" ".backup '${TARGET}'"

# Prune backups older than RETAIN_DAYS.
/usr/bin/find "${BACKUP_DIR}" -name 'assistant.db.*' -type f -mtime "+${RETAIN_DAYS}" -delete

echo "[backup] $(date -Iseconds) wrote ${TARGET}"

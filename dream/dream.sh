#!/bin/bash
set -euo pipefail

log() { echo "$(date -Iseconds) $1"; }

# --- 1. Compute paths ---
PROJECT_DIR="${PROJECT_DIR:-/home/claude/workspace}"
SLUG=$(echo "$PROJECT_DIR" | sed 's|/|-|g')
TRANSCRIPTS_DIR="$HOME/.claude/projects/${SLUG}"
MEMORY_DIR="$HOME/.claude/projects/${SLUG}/memory"
INDEX_FILE="MEMORY.md"
LAST_RUN_FILE="$HOME/.claude/dream.last_run"

# --- 2. Check for new activity ---
if [ -f "$LAST_RUN_FILE" ]; then
  NEW_TRANSCRIPTS=$(find "$TRANSCRIPTS_DIR" -maxdepth 1 -name "*.jsonl" -newer "$LAST_RUN_FILE" 2>/dev/null || true)
  if [ -z "$NEW_TRANSCRIPTS" ]; then
    log "no new activity, skipping"
    exit 0
  fi
else
  # First run — grab all transcripts, but there must be at least one
  NEW_TRANSCRIPTS=$(find "$TRANSCRIPTS_DIR" -maxdepth 1 -name "*.jsonl" 2>/dev/null || true)
  if [ -z "$NEW_TRANSCRIPTS" ]; then
    log "no transcripts found, skipping"
    exit 0
  fi
fi

# --- 3. Build file list for ADDITIONAL_CONTEXT ---
FILE_LIST=""
while IFS= read -r f; do
  FILE_LIST="${FILE_LIST}- ${f}
"
done <<< "$NEW_TRANSCRIPTS"

# --- 4. Render the prompt ---
TEMPLATE=$(cat /opt/dream/prompt.md)
RENDERED="${TEMPLATE//__MEMORY_DIR__/$MEMORY_DIR}"
RENDERED="${RENDERED//__TRANSCRIPTS_DIR__/$TRANSCRIPTS_DIR}"
RENDERED="${RENDERED//__INDEX_FILE__/$INDEX_FILE}"
RENDERED="${RENDERED//__INDEX_MAX_LINES__/200}"
RENDERED="${RENDERED//__ADDITIONAL_CONTEXT__/$FILE_LIST}"

# --- 5. Run the dream ---
log "starting dream..."
if claude --print --dangerously-skip-permissions --model haiku -p "$PROJECT_DIR" "$RENDERED"; then
  # --- 6. Update timestamp on success ---
  touch "$LAST_RUN_FILE"
  log "dream complete"
else
  log "dream failed" >&2
  exit 1
fi

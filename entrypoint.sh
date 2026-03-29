#!/bin/bash
set -e

# Fix ownership on first run (Docker creates named volumes as root)
sudo chown claude:claude /home/claude

PROJECT_DIR="${PROJECT_DIR:-/home/claude/project}"

# git init suppresses workspace trust prompt (directories with .git never trigger it)
mkdir -p "$PROJECT_DIR"
if [ ! -d "$PROJECT_DIR/.git" ]; then
    git init "$PROJECT_DIR"
fi

# Merge required fields into ~/.claude.json without clobbering existing auth state.
# On first run (no file yet), create the skeleton. On subsequent runs, patch in place.
if [ -f ~/.claude.json ]; then
    tmp=$(mktemp)
    jq --arg dir "$PROJECT_DIR" '
      .hasCompletedOnboarding = true |
      .projects[$dir] = (.projects[$dir] // {}) * {
        hasTrustDialogAccepted: true,
        hasCompletedProjectOnboarding: true,
        hasTrustDialogHooksAccepted: true,
        allowedTools: ((.projects[$dir].allowedTools) // [])
      }
    ' ~/.claude.json > "$tmp" && mv "$tmp" ~/.claude.json
else
    cat > ~/.claude.json << EOF
{
  "hasCompletedOnboarding": true,
  "shiftEnterKeyBindingInstalled": true,
  "projects": {
    "$PROJECT_DIR": {
      "hasTrustDialogAccepted": true,
      "hasCompletedProjectOnboarding": true,
      "hasTrustDialogHooksAccepted": true,
      "allowedTools": []
    }
  }
}
EOF
fi

# Suppress "WARNING: running in Bypass Permissions mode" dialog
mkdir -p ~/.claude
cat > ~/.claude/settings.json << 'EOF'
{
  "skipDangerousModePermissionPrompt": true
}
EOF

# Start cron daemon so the agent can schedule cron tasks
sudo cron

cd "$PROJECT_DIR"

export CLAUDE_CODE_DISABLE_CRON=1

exec claude --dangerously-skip-permissions "$@"

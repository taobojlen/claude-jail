#!/bin/bash
set -e

# Fix ownership on first run (Docker creates named volumes as root)
sudo chown ubuntu:ubuntu /home/ubuntu

PROJECT_DIR="${PROJECT_DIR:-/home/ubuntu/workspace}"

# git init suppresses workspace trust prompt (directories with .git never trigger it)
mkdir -p "$PROJECT_DIR"
if [ ! -d "$PROJECT_DIR/.git" ]; then
    git init "$PROJECT_DIR"
fi

# Merge required fields into ~/.claude.json without clobbering existing auth state.
[ -f ~/.claude.json ] || echo '{}' > ~/.claude.json
tmp=$(mktemp)
if [ "${1:-}" = "login" ]; then
    REMOTE_CONTROL="false"
else
    REMOTE_CONTROL="true"
fi
jq --arg dir "$PROJECT_DIR" --argjson rc "$REMOTE_CONTROL" '
  .hasCompletedOnboarding = true |
  .remoteControlAtStartup = $rc |
  .remoteDialogSeen = true |
  .projects[$dir] = (.projects[$dir] // {}) * {
    hasTrustDialogAccepted: true,
    hasCompletedProjectOnboarding: true,
    hasTrustDialogHooksAccepted: true,
    allowedTools: ((.projects[$dir].allowedTools) // [])
  }
' ~/.claude.json > "$tmp" && mv "$tmp" ~/.claude.json

# Suppress "WARNING: running in Bypass Permissions mode" dialog
mkdir -p ~/.claude
cat > ~/.claude/settings.json << 'EOF'
{
  "skipDangerousModePermissionPrompt": true,
  "permissions": {
    "deny": ["RemoteTrigger", "CronCreate", "CronDelete", "CronList"]
  }
}
EOF

# Register MCP channels so Claude Code can find them
cat > "$PROJECT_DIR/.mcp.json" << EOF
{
  "mcpServers": {
    "scheduler": {
      "command": "/opt/scheduler-channel/scheduler-channel",
      "args": [],
      "env": {
        "SCHEDULER_API_PORT": "${SCHEDULER_API_PORT:-8791}",
        "SCHEDULER_CHANNEL_PORT": "${SCHEDULER_CHANNEL_PORT:-8790}"
      }
    },
    "matrix": {
      "command": "/opt/matrix-channel/matrix-channel",
      "args": [],
      "env": {
        "MATRIX_API_PORT": "${MATRIX_API_PORT:-8793}",
        "MATRIX_CHANNEL_PORT": "${MATRIX_CHANNEL_PORT:-8792}"
      }
    }
  }
}
EOF

# Install dream cron job (runs every 2 hours) and start cron daemon
(echo "0 */2 * * * PROJECT_DIR=$PROJECT_DIR /opt/dream/dream.sh >> /home/ubuntu/.claude/logs/dream.log 2>&1") | crontab -
sudo cron

# Start supervisord for background services
sudo supervisord -c /etc/supervisor/supervisord.conf

cd "$PROJECT_DIR"

export CLAUDE_CODE_DISABLE_CRON=1

if [ "${1:-}" = "login" ]; then
    exec claude --model sonnet
else
    # Auto-accept the development channels confirmation prompt.
    # Pattern matching won't work (Ink TUI uses ANSI escapes), so we
    # wait for the prompt to render then send Enter.
    cat > /tmp/accept-prompt.exp <<'EXPECT'
set timeout -1
log_user 1
spawn claude --model sonnet --permission-mode bypassPermissions --remote-control-session-name-prefix agent --dangerously-load-development-channels server:scheduler server:matrix
sleep 10
send "\r"
expect eof
EXPECT
    exec expect /tmp/accept-prompt.exp
fi

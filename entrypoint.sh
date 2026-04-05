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

# System-wide instructions for the agent
cat > ~/.claude/CLAUDE.md << 'EOF'
# Scheduling Tasks

Do NOT use RemoteTrigger, CronCreate, CronDelete, CronList, or the /schedule and /loop skills. They are disabled.

Instead, use the scheduler MCP tools to manage recurring and one-shot tasks:

- `scheduler_add_task` — schedule a task (supports `cron`, `interval_seconds`, or `at` for one-shot)
- `scheduler_remove_task` — remove a task by its ID
- `scheduler_list_tasks` — list all scheduled tasks

When a scheduled task fires, it arrives as a channel message. Execute the prompt in the message body.

# Conversation History

Full transcripts from all past sessions are stored as JSONL files at:
`~/.claude/projects/-home-ubuntu-workspace/`

To search past conversations, use grep:
`grep -rn "search term" ~/.claude/projects/-home-ubuntu-workspace/ --include="*.jsonl" | tail -50`

A dream process runs every 2 hours to consolidate important information into your memory files. You do not need to manually review transcripts unless searching for specific details.

# Matrix Messages

When you receive a message from the matrix channel, it is a DM from your user on Matrix.
Always reply using the \`reply\` tool from the matrix server, passing the \`room_id\` from the channel tag.
Be conversational and helpful.
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

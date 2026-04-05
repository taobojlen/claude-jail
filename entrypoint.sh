#!/bin/bash
set -e

# Fix ownership on first run (Docker creates named volumes as root)
sudo chown claude:claude /home/claude

PROJECT_DIR="${PROJECT_DIR:-/home/claude/workspace}"

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
      .remoteControlAtStartup = true |
      .remoteDialogSeen = true |
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
  "remoteControlAtStartup": true,
  "remoteDialogSeen": true,
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
EOF

# Register the scheduler MCP channel so Claude Code can find it
mkdir -p "$PROJECT_DIR"
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
    }
  }
}
EOF

cd "$PROJECT_DIR"

export CLAUDE_CODE_DISABLE_CRON=1

if [ "${1:-}" = "login" ]; then
    exec claude
else
    # Auto-accept the development channels confirmation prompt.
    # Pattern matching won't work (Ink TUI uses ANSI escapes), so we
    # wait for the prompt to render then send Enter.
    cat > /tmp/accept-prompt.exp <<'EXPECT'
set timeout -1
log_user 1
spawn claude --permission-mode bypassPermissions --dangerously-load-development-channels server:scheduler
sleep 10
send "\r"
expect eof
EXPECT
    exec expect /tmp/accept-prompt.exp
fi

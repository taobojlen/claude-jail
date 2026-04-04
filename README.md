# claude-jail

A sandboxed Docker container for running a persistent Claude Code agent. Claude has full sudo access inside the container but cannot escape it.

## Quick start

```bash
# Build and start in background
docker compose up --build -d

# Attach to the Claude session
docker attach claude-jail-claude-1
```

## First run

On the very first launch, Claude Code has no credentials:

1. `docker compose up --build -d`
2. `docker attach claude-jail-claude-1`
3. Claude will prompt you to log in — run `/login` and select option 1 ("Claude account with subscription")
4. Follow the URL in your browser and authenticate. **Important:** The login URL may wrap in the terminal — remove any spaces inserted by line wrapping before pasting into your browser, or the redirect will fail.

OAuth tokens persist in a named Docker volume (`claude-home`). You only need to log in once. On subsequent runs, just `docker compose up -d` and attach.

## Architecture

- **Non-root user** (`claude`) with passwordless sudo — full control inside the container, no escape
- **tini** as PID 1 — reaps zombies, forwards signals
- **cron** daemon running — Claude can create its own scheduled tasks
- **`--dangerously-skip-permissions`** — all tool permission prompts bypassed
- **`CLAUDE_CODE_DISABLE_CRON=1`** — disables Claude Code's built-in cron (system cron is used instead)
- **Named volume** — `claude-home` for Claude state

## Security

The container is locked down to prevent escape while giving Claude full freedom inside:

| Control | Setting |
|---|---|
| Capabilities | `cap_drop: ALL`, only CHOWN/DAC_OVERRIDE/FOWNER/SETGID/SETUID added back |
| Network | Default bridge network (outbound internet works, no host network access) |
| Resources | 4GB RAM, 2 CPUs, 512 process limit |
| Filesystem | `/tmp` as tmpfs (512MB) |
| Restart | `unless-stopped` — auto-restarts on crash, stays down on explicit stop |

## Configuration

| Environment variable | Default | Description |
|---|---|---|
| `PROJECT_DIR` | `/home/claude/project` | Working directory for Claude |

```bash
# Use a custom project directory
docker compose run -e PROJECT_DIR=/home/claude/myproject claude
```

## Managing the container

```bash
# Attach to a running container
docker attach claude-jail-claude-1

# Stop (won't auto-restart)
docker compose stop

# Stop and remove container (volume persists)
docker compose down

# Nuclear reset — wipes all state including auth
docker compose down -v
```

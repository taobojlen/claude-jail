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

## Signal integration

Claude can send and receive Signal messages via a two-way channel. Signal-cli runs in a separate container so Claude cannot access the Signal account keys.

### Setup

1. Create a `.env` file:
   ```
   SIGNAL_ACCOUNT=+12025551234
   SIGNAL_ALLOWED_SENDERS=+12025559876
   ```

2. Register or copy an existing signal-cli account:
   ```bash
   # Option A: Copy existing signal-cli data into the volume
   docker compose up --build -d
   docker compose cp /path/to/signal-cli/data/. signal:/home/signal/.local/share/signal-cli/

   # Option B: Register a new number
   docker compose up --build -d
   docker compose exec signal bash
   signal-cli -a +NUMBER register   # may need CAPTCHA, see signal-cli wiki
   signal-cli -a +NUMBER verify CODE
   ```

3. Restart and verify:
   ```bash
   docker compose restart
   docker attach claude-jail-claude-1
   ```
   Run `/mcp` in Claude — the `signal` server should show as connected.

4. Send a message from your phone to the registered number. It should appear in Claude's session. Claude replies via the `signal_reply` tool.

### Security

Signal-cli runs in its own container on an internal network. Claude communicates with it over HTTP but cannot access the Signal account keys, send messages to numbers outside the allowlist, or register/deregister accounts.

## Architecture

- **Non-root user** (`claude`) with passwordless sudo — full control inside the container, no escape
- **tini** as PID 1 — reaps zombies, forwards signals
- **cron** daemon running — Claude can create its own scheduled tasks
- **`--dangerously-skip-permissions`** — all tool permission prompts bypassed
- **`CLAUDE_CODE_DISABLE_CRON=1`** — disables Claude Code's built-in cron (system cron is used instead)
- **Signal channel** — two-way messaging via signal-cli in a separate container
- **Named volumes** — `claude-home` for Claude state, `signal-data` for Signal account keys

## Security

The container is locked down to prevent escape while giving Claude full freedom inside:

| Control | Setting |
|---|---|
| Capabilities | `cap_drop: ALL`, only CHOWN/DAC_OVERRIDE/FOWNER/SETGID/SETUID added back |
| Network | Isolated bridge network (outbound internet works, no host network access) |
| Resources | 4GB RAM, 2 CPUs, 512 process limit |
| Filesystem | `/tmp` as tmpfs (512MB) |
| Restart | `unless-stopped` — auto-restarts on crash, stays down on explicit stop |

## Configuration

| Environment variable | Default | Description |
|---|---|---|
| `PROJECT_DIR` | `/home/claude/project` | Working directory for Claude |
| `SIGNAL_ACCOUNT` | (none) | Phone number registered with signal-cli |
| `SIGNAL_ALLOWED_SENDERS` | (none) | Comma-separated phone numbers allowed to message |

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

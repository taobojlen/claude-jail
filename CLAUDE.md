# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Rules

- **NEVER delete files inside the container (or its volumes) without explicit user approval.** The container has persistent state that may be irreplaceable. Always ask first.

## Project Overview

**claude-jail** is a sandboxed Docker environment for running a persistent Claude Code agent. Claude gets full sudo inside the container but cannot escape it.

## Commands

```bash
# First-time auth (interactive, one-shot)
docker compose run --rm -it claude login

# Build and start remote control server
docker compose up --build -d

# Stop (preserves volumes)
docker compose down

# Nuclear reset (wipes auth + all state)
docker compose down -v
```

Tests: `cd scheduler/api && bun test` and `cd scheduler/channel && bun test`

## Architecture

Two Docker containers orchestrated via docker-compose:

1. **claude** (Ubuntu 24.04) — Claude Code in Remote Control server mode with `--dangerously-skip-permissions`. Users interact via claude.ai/code or the Claude mobile app. Uses tini as PID 1, Claude Code built-in cron disabled (`CLAUDE_CODE_DISABLE_CRON=1`). Includes a scheduler MCP channel that provides `scheduler_add_task`, `scheduler_remove_task`, `scheduler_list_tasks` tools.

2. **scheduler** (Bun) — Lightweight task scheduler. HTTP API for CRUD on tasks, 10-second poll loop that fires due tasks by POSTing to the channel. Stores tasks in `/data/tasks.json`. Supports cron expressions, intervals, and one-shot timestamps.

### Key files

- `Dockerfile` — Container image: Ubuntu 24.04, Claude Code CLI + Bun install, non-root `ubuntu` user with passwordless sudo
- `entrypoint.sh` — Container init: volume ownership fix, git init, `.claude.json` config patching, MCP channel registration, launches Claude Code in remote-control mode (or interactive mode with `login` arg)
- `docker-compose.yml` — Two services (claude + scheduler) with security constraints (capability dropping, resource limits)
- `scheduler/api/` — Scheduler container: HTTP API + poll loop (Bun)
- `scheduler/channel/` — MCP channel that proxies tool calls to the scheduler API (runs inside claude container)

### Security constraints

- `cap_drop: ALL` with only CHOWN/DAC_OVERRIDE/FOWNER/SETGID/SETUID added back
- 4GB RAM, 2 CPUs, 512 process limit
- `/tmp` as tmpfs (512MB)
- Named volume `claude-home` persists Claude state (including OAuth tokens)

### Environment variables

- `PROJECT_DIR` — Claude's working directory inside container (default: `/home/ubuntu/workspace`)
- `SCHEDULER_API_PORT` — Scheduler HTTP API port (default: `8791`)
- `SCHEDULER_CHANNEL_PORT` — Channel HTTP listener port (default: `8790`)

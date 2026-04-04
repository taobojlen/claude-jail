# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**claude-jail** is a sandboxed Docker environment for running a persistent Claude Code agent. Claude gets full sudo inside the container but cannot escape it.

## Commands

```bash
# Build and start
docker compose up --build -d

# Attach to Claude's interactive session
docker attach claude-jail-claude-1

# Stop (preserves volumes)
docker compose down

# Nuclear reset (wipes auth + all state)
docker compose down -v
```

There are no test suites, linters, or build steps.

## Architecture

Single Docker container (Ubuntu 24.04) running Claude Code with `--dangerously-skip-permissions`. Uses tini as PID 1, system cron enabled, Claude Code built-in cron disabled (`CLAUDE_CODE_DISABLE_CRON=1`).

### Key files

- `Dockerfile` — Container image: Ubuntu 24.04, Claude Code CLI install, non-root `claude` user with passwordless sudo
- `entrypoint.sh` — Container init: volume ownership fix, git init, `.claude.json` config patching, cron start, launches Claude Code
- `docker-compose.yml` — Service definition with security constraints (capability dropping, resource limits)

### Security constraints

- `cap_drop: ALL` with only CHOWN/DAC_OVERRIDE/FOWNER/SETGID/SETUID added back
- 4GB RAM, 2 CPUs, 512 process limit
- `/tmp` as tmpfs (512MB)
- Named volume `claude-home` persists Claude state (including OAuth tokens)

### Environment variables

- `PROJECT_DIR` — Claude's working directory inside container (default: `/home/claude/project`)

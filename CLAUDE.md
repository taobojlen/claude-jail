# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

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

There are no test suites, linters, or build steps.

## Architecture

Single Docker container (Ubuntu 24.04) running Claude Code in Remote Control server mode with `--dangerously-skip-permissions`. Users interact via claude.ai/code or the Claude mobile app. Uses tini as PID 1, system cron enabled, Claude Code built-in cron disabled (`CLAUDE_CODE_DISABLE_CRON=1`).

### Key files

- `Dockerfile` — Container image: Ubuntu 24.04, Claude Code CLI install, non-root `claude` user with passwordless sudo
- `entrypoint.sh` — Container init: volume ownership fix, git init, `.claude.json` config patching, cron start, launches Claude Code in remote-control mode (or interactive mode with `login` arg)
- `docker-compose.yml` — Service definition with security constraints (capability dropping, resource limits)

### Security constraints

- `cap_drop: ALL` with only CHOWN/DAC_OVERRIDE/FOWNER/SETGID/SETUID added back
- 4GB RAM, 2 CPUs, 512 process limit
- `/tmp` as tmpfs (512MB)
- Named volume `claude-home` persists Claude state (including OAuth tokens)

### Environment variables

- `PROJECT_DIR` — Claude's working directory inside container (default: `/home/claude/workspace`)

# Scheduler: Isolated Recurring Tasks for Claude Agent

## Overview

Add scheduled/recurring task support to the claude-jail agent. The agent creates tasks via MCP tools; a separate container stores and fires them. When a task is due, the scheduler POSTs the prompt into the Claude Code session via the existing channel mechanism.

## Architecture

```
┌──────────────────────────┐         ┌────────────────────────┐
│  claude container         │         │  scheduler container    │
│                           │  POST   │                         │
│  Claude Code              │◄────────│  poll loop (10s)        │
│    ↕ stdio                │  :8790  │  tasks.json (volume)    │
│  MCP channel (scheduler)  │         │  HTTP API :8791         │
│    - HTTP listener :8790  │────────►│                         │
│    - tools (proxy to API) │  HTTP   │                         │
└──────────────────────────┘         └────────────────────────┘
```

Both ports are configurable via environment variables in docker-compose.yml:
- `SCHEDULER_CHANNEL_PORT` (default `8790`) — channel HTTP listener in the claude container
- `SCHEDULER_API_PORT` (default `8791`) — scheduler HTTP API
Each container constructs the other's URL from the service name and the relevant port variable.

## Scheduler Container

### Task schema

```json
{
  "id": "a1b2c3",
  "name": "daily-analysis",
  "schedule_type": "cron",
  "schedule_value": "0 9 * * *",
  "prompt": "Analyze the data and send me a summary",
  "next_run": "2026-04-05T09:00:00.000Z",
  "last_run": null,
  "created_at": "2026-04-04T12:00:00.000Z"
}
```

`schedule_type` is one of:
- `cron` — 5-field cron expression in `schedule_value`
- `interval` — milliseconds in `schedule_value`
- `once` — ISO 8601 timestamp in `schedule_value`

### HTTP API

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/tasks` | List all tasks |
| `POST` | `/tasks` | Create a task. Body: `{ name, schedule_type, schedule_value, prompt }`. Returns created task with generated `id` and computed `next_run`. |
| `DELETE` | `/tasks/:id` | Remove a task. Returns 200 on success, 404 if not found. |

### Poll loop

Runs every 10 seconds:

1. Read `tasks.json` from disk
2. Find tasks where `next_run <= now`
3. For each due task:
   a. POST prompt to `http://claude:${SCHEDULER_CHANNEL_PORT}/` with `X-Task-Id` and `X-Task-Name` headers
   b. Update `last_run` to now
   c. Compute `next_run`:
      - `cron`: next occurrence from cron expression (using `cron-parser`)
      - `interval`: `now + parseInt(schedule_value)`
      - `once`: remove the task from the store
4. Save `tasks.json`

### next_run computation

For `cron`: use `cron-parser` to get the next occurrence.

For `interval`: `next_run = now + interval_ms`. On first create, `next_run = created_at + interval_ms`. No drift compensation — intervals anchor to when they actually fire, not when they were scheduled. This is intentional simplicity; the 10s poll granularity already means we're not precise.

For `once`: `next_run = schedule_value` (the ISO timestamp). After firing, the task is deleted.

### Storage

Single file: `/data/tasks.json` containing `{ "tasks": [...] }`. Persisted on a `scheduler-data` Docker named volume. Read on every poll tick, written after any mutation. No database, no WAL — the file is small and writes are infrequent.

### Dockerfile

Minimal: `oven/bun:latest` base image, copy source, `CMD ["bun", "run", "scheduler.ts"]`. No apt packages needed.

## MCP Channel (modified from cron-channel.ts → scheduler-channel.ts)

### What stays

- MCP server declaration with `claude/channel` capability and `tools` capability
- HTTP listener on port `SCHEDULER_CHANNEL_PORT` that receives POSTs and forwards them as `notifications/claude/channel`
- Tool declarations for `scheduler_add_task`, `scheduler_remove_task`, `scheduler_list_tasks`

### What changes

Tool implementations become HTTP proxies to the scheduler API:

- `scheduler_add_task` → `POST http://scheduler:${SCHEDULER_API_PORT}/tasks` with `{ name: task_id, schedule_type, schedule_value, prompt }`
- `scheduler_remove_task` → `DELETE http://scheduler:${SCHEDULER_API_PORT}/tasks/${task_id}`
- `scheduler_list_tasks` → `GET http://scheduler:${SCHEDULER_API_PORT}/tasks`

### Updated tool schema

`scheduler_add_task` gains new parameters:

| Parameter | Type | Description |
|-----------|------|-------------|
| `task_id` | string | Unique name for the task |
| `prompt` | string | Prompt to inject when the task fires |
| `cron` | string | 5-field cron expression (mutually exclusive with `interval_seconds` and `at`) |
| `interval_seconds` | number | Repeat interval in seconds (mutually exclusive) |
| `at` | string | ISO 8601 timestamp for one-shot execution (mutually exclusive) |

The tool implementation maps these to `schedule_type` + `schedule_value` for the scheduler API.

## docker-compose.yml changes

```yaml
services:
  claude:
    # ... existing config ...
    environment:
      - SCHEDULER_CHANNEL_PORT=${SCHEDULER_CHANNEL_PORT:-8790}
      - SCHEDULER_API_PORT=${SCHEDULER_API_PORT:-8791}
    depends_on:
      - scheduler

  scheduler:
    build: ./scheduler
    restart: unless-stopped
    volumes:
      - scheduler-data:/data
    environment:
      - SCHEDULER_API_PORT=${SCHEDULER_API_PORT:-8791}
      - SCHEDULER_CHANNEL_PORT=${SCHEDULER_CHANNEL_PORT:-8790}
    mem_limit: 256m
    cpus: 0.5
    pids_limit: 64

volumes:
  claude-home:
  scheduler-data:
```

The scheduler container gets tight resource limits — it's just a JSON file and a poll loop.

## Claude container changes

### Dockerfile

Install Bun (for the MCP channel):
```dockerfile
RUN curl -fsSL https://bun.sh/install | bash
ENV PATH="/home/claude/.bun/bin:$PATH"
```

Copy the channel source into the image:
```dockerfile
COPY --chown=claude:claude scheduler/channel/ /opt/scheduler-channel/
RUN cd /opt/scheduler-channel && bun install --production
```

### entrypoint.sh

Add `--dangerously-load-development-channels server:scheduler` to the `claude remote-control` command. The channel's `.mcp.json` tells Claude Code how to start the MCP server.

Cron daemon startup (`sudo cron`) can be removed — we no longer use system crontab for scheduling.

## File changes summary

### New files
- `scheduler/api/scheduler.ts` — poll loop + HTTP API
- `scheduler/api/Dockerfile` — minimal Bun container
- `scheduler/api/package.json` — dependencies (cron-parser)
- `scheduler/channel/scheduler-channel.ts` — MCP channel (adapted from cron/)
- `scheduler/channel/scheduler-channel.test.ts` — channel tests
- `scheduler/channel/package.json`
- `scheduler/channel/.mcp.json`

### Modified files
- `docker-compose.yml` — add scheduler service, env vars, volume
- `Dockerfile` — install Bun, copy channel
- `entrypoint.sh` — load channel, remove cron daemon start

### Files from cron/ to adapt
The `cron/` directory is the starting point. We take the MCP server + HTTP listener code and rename/modify it into `scheduler/channel/`. The crontab-specific files are dropped entirely:
- `cron-channel.ts` → `scheduler/channel/scheduler-channel.ts` (tools become API proxies)
- `cron-channel.test.ts` → `scheduler/channel/scheduler-channel.test.ts` (updated)
- Drop: `crontab.ts`, `crontab.test.ts`, `install.sh`, `install.test.sh`

## Limitations

- If the claude container is down when a task fires, the scheduler's POST fails and the prompt is lost. No retry queue.
- 10-second poll granularity means tasks can fire up to ~10s late.
- No catch-up for missed fires (e.g., if scheduler was down).
- No timezone support for cron expressions (UTC only). Can be added later if needed.

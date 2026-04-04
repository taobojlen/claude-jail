import { parseExpression } from "cron-parser";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname } from "node:path";

const TASKS_FILE = process.env.TASKS_FILE || "/data/tasks.json";
const SCHEDULER_API_PORT = parseInt(process.env.SCHEDULER_API_PORT || "8791", 10);
const SCHEDULER_CHANNEL_PORT = parseInt(process.env.SCHEDULER_CHANNEL_PORT || "8790", 10);
const POLL_INTERVAL = 10_000;

interface Task {
  id: string;
  name: string;
  schedule_type: "cron" | "interval" | "once";
  schedule_value: string;
  prompt: string;
  next_run: string;
  last_run: string | null;
  created_at: string;
}

interface TaskStore {
  tasks: Task[];
}

export async function loadTasks(): Promise<TaskStore> {
  try {
    const data = await readFile(TASKS_FILE, "utf-8");
    return JSON.parse(data) as TaskStore;
  } catch {
    return { tasks: [] };
  }
}

export async function saveTasks(store: TaskStore): Promise<void> {
  const dir = dirname(TASKS_FILE);
  if (!existsSync(dir)) {
    await mkdir(dir, { recursive: true });
  }
  await writeFile(TASKS_FILE, JSON.stringify(store, null, 2));
}

export function computeNextRun(scheduleType: string, scheduleValue: string, from: Date = new Date()): string {
  switch (scheduleType) {
    case "cron": {
      const interval = parseExpression(scheduleValue, { currentDate: from });
      return interval.next().toISOString();
    }
    case "interval": {
      const ms = parseInt(scheduleValue, 10);
      return new Date(from.getTime() + ms).toISOString();
    }
    case "once": {
      return new Date(scheduleValue).toISOString();
    }
    default:
      throw new Error(`Unknown schedule_type: ${scheduleType}`);
  }
}

export async function pollTick(now: Date = new Date()): Promise<void> {
  const store = await loadTasks();
  const toRemove: string[] = [];
  let changed = false;

  for (const task of store.tasks) {
    if (new Date(task.next_run) <= now) {
      try {
        await fetch(`http://claude:${SCHEDULER_CHANNEL_PORT}/`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Task-Id": task.id,
            "X-Task-Name": task.name,
          },
          body: JSON.stringify({ prompt: task.prompt }),
        });
        console.log(`Fired task ${task.id} (${task.name})`);
      } catch (err) {
        console.error(`Failed to fire task ${task.id}:`, err);
      }

      task.last_run = now.toISOString();
      changed = true;

      if (task.schedule_type === "once") {
        toRemove.push(task.id);
      } else {
        task.next_run = computeNextRun(task.schedule_type, task.schedule_value, now);
      }
    }
  }

  if (toRemove.length > 0) {
    store.tasks = store.tasks.filter((t) => !toRemove.includes(t.id));
  }

  if (changed) {
    await saveTasks(store);
  }
}

const server = Bun.serve({
  port: SCHEDULER_API_PORT,
  hostname: "0.0.0.0",
  async fetch(req) {
    const url = new URL(req.url);

    if (url.pathname === "/tasks" && req.method === "GET") {
      const store = await loadTasks();
      return Response.json(store);
    }

    if (url.pathname === "/tasks" && req.method === "POST") {
      const body = await req.json();
      const { name, schedule_type, schedule_value, prompt } = body;

      if (!name || !schedule_type || !schedule_value || !prompt) {
        return Response.json({ error: "Missing required fields" }, { status: 400 });
      }

      if (!["cron", "interval", "once"].includes(schedule_type)) {
        return Response.json({ error: "Invalid schedule_type" }, { status: 400 });
      }

      const now = new Date();
      const task: Task = {
        id: crypto.randomUUID().slice(0, 8),
        name,
        schedule_type,
        schedule_value,
        prompt,
        next_run: computeNextRun(schedule_type, schedule_value, now),
        last_run: null,
        created_at: now.toISOString(),
      };

      const store = await loadTasks();
      store.tasks.push(task);
      await saveTasks(store);

      return Response.json(task, { status: 201 });
    }

    const deleteMatch = url.pathname.match(/^\/tasks\/([^/]+)$/);
    if (deleteMatch && req.method === "DELETE") {
      const id = deleteMatch[1];
      const store = await loadTasks();
      const idx = store.tasks.findIndex((t) => t.id === id);
      if (idx === -1) {
        return Response.json({ error: "Not found" }, { status: 404 });
      }
      store.tasks.splice(idx, 1);
      await saveTasks(store);
      return Response.json({ ok: true });
    }

    return Response.json({ error: "Not found" }, { status: 404 });
  },
});

const pollInterval = setInterval(() => {
  pollTick().catch((err) => console.error("Poll error:", err));
}, POLL_INTERVAL);

console.log(`Scheduler API listening on 0.0.0.0:${SCHEDULER_API_PORT}`);

function shutdown() {
  console.log("Shutting down...");
  clearInterval(pollInterval);
  server.stop();
  process.exit(0);
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

export { server, pollInterval };

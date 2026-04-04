import { describe, test, expect, beforeEach, afterAll } from "bun:test";
import { computeNextRun, loadTasks, saveTasks, pollTick, server, pollInterval } from "./scheduler";
import { unlink } from "node:fs/promises";

const TASKS_FILE = process.env.TASKS_FILE!;
const BASE = `http://localhost:${server.port}`;

async function resetTasks() {
  await saveTasks({ tasks: [] });
}

beforeEach(async () => {
  await resetTasks();
});

afterAll(async () => {
  clearInterval(pollInterval);
  server.stop();
  try {
    await unlink(TASKS_FILE);
  } catch {}
});

// --- next_run computation ---

describe("computeNextRun", () => {
  test("cron: returns next occurrence", () => {
    const from = new Date("2026-04-04T08:00:00.000Z");
    const next = computeNextRun("cron", "0 9 * * *", from);
    expect(next).toBe("2026-04-04T09:00:00.000Z");
  });

  test("cron: wraps to next day if past time", () => {
    const from = new Date("2026-04-04T10:00:00.000Z");
    const next = computeNextRun("cron", "0 9 * * *", from);
    expect(next).toBe("2026-04-05T09:00:00.000Z");
  });

  test("interval: adds milliseconds to from", () => {
    const from = new Date("2026-04-04T12:00:00.000Z");
    const next = computeNextRun("interval", "3600000", from);
    expect(next).toBe("2026-04-04T13:00:00.000Z");
  });

  test("once: returns the schedule_value as ISO", () => {
    const next = computeNextRun("once", "2026-05-01T00:00:00.000Z");
    expect(next).toBe("2026-05-01T00:00:00.000Z");
  });
});

// --- HTTP API CRUD ---

describe("HTTP API", () => {
  test("GET /tasks returns empty list initially", async () => {
    const res = await fetch(`${BASE}/tasks`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ tasks: [] });
  });

  test("POST /tasks creates a task", async () => {
    const res = await fetch(`${BASE}/tasks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "test-task",
        schedule_type: "interval",
        schedule_value: "60000",
        prompt: "Do something",
      }),
    });
    expect(res.status).toBe(201);
    const task = await res.json();
    expect(task.id).toBeString();
    expect(task.id.length).toBe(8);
    expect(task.name).toBe("test-task");
    expect(task.schedule_type).toBe("interval");
    expect(task.next_run).toBeString();
    expect(task.last_run).toBeNull();
    expect(task.created_at).toBeString();
  });

  test("POST /tasks validates required fields", async () => {
    const res = await fetch(`${BASE}/tasks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "incomplete" }),
    });
    expect(res.status).toBe(400);
  });

  test("POST /tasks validates schedule_type", async () => {
    const res = await fetch(`${BASE}/tasks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "bad-type",
        schedule_type: "bogus",
        schedule_value: "123",
        prompt: "test",
      }),
    });
    expect(res.status).toBe(400);
  });

  test("GET /tasks lists created tasks", async () => {
    await fetch(`${BASE}/tasks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "t1",
        schedule_type: "once",
        schedule_value: "2026-05-01T00:00:00.000Z",
        prompt: "p1",
      }),
    });
    await fetch(`${BASE}/tasks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "t2",
        schedule_type: "interval",
        schedule_value: "5000",
        prompt: "p2",
      }),
    });

    const res = await fetch(`${BASE}/tasks`);
    const body = await res.json();
    expect(body.tasks.length).toBe(2);
  });

  test("DELETE /tasks/:id removes a task", async () => {
    const createRes = await fetch(`${BASE}/tasks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "to-delete",
        schedule_type: "interval",
        schedule_value: "1000",
        prompt: "bye",
      }),
    });
    const task = await createRes.json();

    const delRes = await fetch(`${BASE}/tasks/${task.id}`, { method: "DELETE" });
    expect(delRes.status).toBe(200);

    const listRes = await fetch(`${BASE}/tasks`);
    const body = await listRes.json();
    expect(body.tasks.length).toBe(0);
  });

  test("DELETE /tasks/:id returns 404 for missing task", async () => {
    const res = await fetch(`${BASE}/tasks/nonexist`, { method: "DELETE" });
    expect(res.status).toBe(404);
  });
});

// --- Poll loop ---

describe("pollTick", () => {
  test("fires due tasks and updates last_run/next_run", async () => {
    const fetchCalls: { url: string; headers: Record<string, string>; body: any }[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input: any, init: any) => {
      const url = typeof input === "string" ? input : input.url;
      if (url.includes("claude:")) {
        fetchCalls.push({
          url,
          headers: Object.fromEntries(new Headers(init?.headers).entries()),
          body: JSON.parse(init?.body),
        });
        return new Response("ok");
      }
      return originalFetch(input, init);
    };

    try {
      const now = new Date("2026-04-04T12:00:00.000Z");
      await saveTasks({
        tasks: [
          {
            id: "abc12345",
            name: "due-task",
            schedule_type: "interval",
            schedule_value: "60000",
            prompt: "Run this",
            next_run: "2026-04-04T11:59:00.000Z",
            last_run: null,
            created_at: "2026-04-04T10:00:00.000Z",
          },
          {
            id: "def45678",
            name: "future-task",
            schedule_type: "interval",
            schedule_value: "60000",
            prompt: "Not yet",
            next_run: "2026-04-04T13:00:00.000Z",
            last_run: null,
            created_at: "2026-04-04T10:00:00.000Z",
          },
        ],
      });

      await pollTick(now);

      // Only the due task should have fired
      expect(fetchCalls.length).toBe(1);
      expect(fetchCalls[0].headers["x-task-id"]).toBe("abc12345");
      expect(fetchCalls[0].headers["x-task-name"]).toBe("due-task");
      expect(fetchCalls[0].body.prompt).toBe("Run this");

      const store = await loadTasks();
      const dueTask = store.tasks.find((t) => t.id === "abc12345")!;
      expect(dueTask.last_run).toBe("2026-04-04T12:00:00.000Z");
      expect(new Date(dueTask.next_run).getTime()).toBe(
        new Date("2026-04-04T12:00:00.000Z").getTime() + 60000
      );

      // Future task untouched
      const futureTask = store.tasks.find((t) => t.id === "def45678")!;
      expect(futureTask.last_run).toBeNull();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("removes once tasks after firing", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input: any, init: any) => {
      const url = typeof input === "string" ? input : input.url;
      if (url.includes("claude:")) return new Response("ok");
      return originalFetch(input, init);
    };

    try {
      await saveTasks({
        tasks: [
          {
            id: "once1abc",
            name: "one-shot",
            schedule_type: "once",
            schedule_value: "2026-04-04T11:00:00.000Z",
            prompt: "Fire once",
            next_run: "2026-04-04T11:00:00.000Z",
            last_run: null,
            created_at: "2026-04-04T10:00:00.000Z",
          },
        ],
      });

      await pollTick(new Date("2026-04-04T12:00:00.000Z"));

      const store = await loadTasks();
      expect(store.tasks.length).toBe(0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("cron task gets correct next_run after firing", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input: any, init: any) => {
      const url = typeof input === "string" ? input : input.url;
      if (url.includes("claude:")) return new Response("ok");
      return originalFetch(input, init);
    };

    try {
      await saveTasks({
        tasks: [
          {
            id: "cron1abc",
            name: "daily",
            schedule_type: "cron",
            schedule_value: "0 9 * * *",
            prompt: "Morning report",
            next_run: "2026-04-04T09:00:00.000Z",
            last_run: null,
            created_at: "2026-04-03T00:00:00.000Z",
          },
        ],
      });

      await pollTick(new Date("2026-04-04T09:00:05.000Z"));

      const store = await loadTasks();
      expect(store.tasks.length).toBe(1);
      expect(store.tasks[0].last_run).toBe("2026-04-04T09:00:05.000Z");
      expect(store.tasks[0].next_run).toBe("2026-04-05T09:00:00.000Z");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

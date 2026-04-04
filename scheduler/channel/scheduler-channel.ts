#!/usr/bin/env bun
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

export const server = new Server(
  { name: "scheduler", version: "0.0.1" },
  {
    capabilities: {
      experimental: { "claude/channel": {} },
      tools: {},
    },
    instructions: [
      "Events from the scheduler channel are scheduled tasks fired by the scheduler service.",
      "Execute the prompt in the channel body. The task_id and task_name meta fields identify which task fired.",
      "Manage scheduled tasks using the scheduler_add_task, scheduler_remove_task, and scheduler_list_tasks tools.",
    ].join(" "),
  },
);

function getApiBase(): string {
  const port = process.env.SCHEDULER_API_PORT || "8791";
  return `http://scheduler:${port}`;
}

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "scheduler_add_task",
      description:
        "Schedule a task via the scheduler service. Exactly one of cron, interval_seconds, or at must be provided.",
      inputSchema: {
        type: "object" as const,
        properties: {
          task_id: {
            type: "string",
            description:
              "Unique name for the task. Used to identify it later.",
          },
          prompt: {
            type: "string",
            description: "The prompt to inject into the session when the task fires.",
          },
          cron: {
            type: "string",
            description:
              "5-field cron expression: minute hour day-of-month month day-of-week. Example: '0 9 * * *' for daily at 9am.",
          },
          interval_seconds: {
            type: "number",
            description: "Repeat interval in seconds.",
          },
          at: {
            type: "string",
            description: "ISO 8601 timestamp for a one-shot task.",
          },
        },
        required: ["task_id", "prompt"],
      },
    },
    {
      name: "scheduler_remove_task",
      description: "Remove a scheduled task by its task_id.",
      inputSchema: {
        type: "object" as const,
        properties: {
          task_id: {
            type: "string",
            description: "The task_id of the task to remove.",
          },
        },
        required: ["task_id"],
      },
    },
    {
      name: "scheduler_list_tasks",
      description: "List all scheduled tasks managed by the scheduler service.",
      inputSchema: {
        type: "object" as const,
        properties: {},
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;
  const base = getApiBase();

  switch (name) {
    case "scheduler_add_task": {
      const { task_id, prompt, cron, interval_seconds, at } = args as {
        task_id: string;
        prompt: string;
        cron?: string;
        interval_seconds?: number;
        at?: string;
      };

      const scheduleCount = [cron, interval_seconds, at].filter((v) => v !== undefined).length;
      if (scheduleCount !== 1) {
        return {
          content: [
            {
              type: "text" as const,
              text: "Exactly one of cron, interval_seconds, or at must be provided.",
            },
          ],
          isError: true,
        };
      }

      let body: { name: string; schedule_type: string; schedule_value: string; prompt: string };
      if (cron !== undefined) {
        body = { name: task_id, schedule_type: "cron", schedule_value: cron, prompt };
      } else if (interval_seconds !== undefined) {
        body = { name: task_id, schedule_type: "interval", schedule_value: String(interval_seconds * 1000), prompt };
      } else {
        body = { name: task_id, schedule_type: "once", schedule_value: new Date(at!).toISOString(), prompt };
      }

      const res = await fetch(`${base}/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const errText = await res.text();
        return {
          content: [{ type: "text" as const, text: `Failed to add task: ${errText}` }],
          isError: true,
        };
      }

      const task = await res.json();
      return {
        content: [
          {
            type: "text" as const,
            text: `Scheduled task "${task_id}" (id: ${task.id}, type: ${task.schedule_type}, value: ${task.schedule_value}). Next run: ${task.next_run}`,
          },
        ],
      };
    }
    case "scheduler_remove_task": {
      const { task_id } = args as { task_id: string };
      const res = await fetch(`${base}/tasks/${task_id}`, { method: "DELETE" });

      if (res.status === 404) {
        return {
          content: [{ type: "text" as const, text: `Task "${task_id}" not found.` }],
        };
      }
      if (!res.ok) {
        const errText = await res.text();
        return {
          content: [{ type: "text" as const, text: `Failed to remove task: ${errText}` }],
          isError: true,
        };
      }

      return {
        content: [{ type: "text" as const, text: `Removed task "${task_id}".` }],
      };
    }
    case "scheduler_list_tasks": {
      const res = await fetch(`${base}/tasks`);
      if (!res.ok) {
        const errText = await res.text();
        return {
          content: [{ type: "text" as const, text: `Failed to list tasks: ${errText}` }],
          isError: true,
        };
      }

      const data = await res.json();
      const tasks = data.tasks || [];
      if (tasks.length === 0) {
        return {
          content: [{ type: "text" as const, text: "No scheduled tasks." }],
        };
      }
      const lines = tasks.map(
        (t: any) =>
          `- ${t.name} (id: ${t.id}, type: ${t.schedule_type}): "${t.schedule_value}" → ${t.prompt} [next: ${t.next_run}]`,
      );
      return {
        content: [{ type: "text" as const, text: lines.join("\n") }],
      };
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
});

const DEFAULT_PORT = 8790;

export function getPort(): number {
  const env = process.env.SCHEDULER_CHANNEL_PORT;
  return env ? parseInt(env, 10) : DEFAULT_PORT;
}

export function startHttpServer(port: number) {
  return Bun.serve({
    port,
    hostname: "127.0.0.1",
    async fetch(req) {
      if (req.method !== "POST") {
        return new Response("method not allowed", { status: 405 });
      }
      const body = await req.text();
      if (!body.trim()) {
        return new Response("empty body", { status: 400 });
      }
      const meta: Record<string, string> = {};
      const taskId = req.headers.get("X-Task-Id");
      const taskName = req.headers.get("X-Task-Name");
      if (taskId) meta.task_id = taskId;
      if (taskName) meta.task_name = taskName;
      await server.notification({
        method: "notifications/claude/channel",
        params: {
          content: body,
          meta,
        },
      });
      return new Response("ok");
    },
  });
}

// Main entrypoint: connect to Claude Code over stdio and start HTTP listener
if (import.meta.main) {
  await server.connect(new StdioServerTransport());
  const port = getPort();
  startHttpServer(port);
  process.stderr.write(`scheduler-channel: listening on http://127.0.0.1:${port}\n`);
}

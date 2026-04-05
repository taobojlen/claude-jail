#!/usr/bin/env bun
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

export const server = new Server(
  { name: "matrix", version: "0.0.1" },
  {
    capabilities: {
      experimental: { "claude/channel": {} },
      tools: {},
    },
    instructions:
      'Messages arrive as <channel source="matrix" room_id="..." sender="...">. ' +
      "These are DMs from your user on Matrix. " +
      "Reply with the reply tool, passing the room_id from the tag.",
  },
);

function getApiBase(): string {
  const port = process.env.MATRIX_API_PORT || "8793";
  return `http://matrix:${port}`;
}

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "reply",
      description: "Send a message back to the user on Matrix.",
      inputSchema: {
        type: "object" as const,
        properties: {
          room_id: {
            type: "string",
            description: "The Matrix room to reply in (from the channel tag).",
          },
          text: {
            type: "string",
            description: "The message text to send.",
          },
        },
        required: ["room_id", "text"],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  if (req.params.name === "reply") {
    const { room_id, text } = req.params.arguments as {
      room_id: string;
      text: string;
    };

    const res = await fetch(`${getApiBase()}/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ room_id, body: text }),
    });

    if (!res.ok) {
      const errText = await res.text();
      return {
        content: [{ type: "text" as const, text: `Failed to send: ${errText}` }],
        isError: true,
      };
    }

    return {
      content: [{ type: "text" as const, text: "sent" }],
    };
  }
  throw new Error(`Unknown tool: ${req.params.name}`);
});

const DEFAULT_PORT = 8792;

export function getPort(): number {
  const env = process.env.MATRIX_CHANNEL_PORT;
  return env ? parseInt(env, 10) : DEFAULT_PORT;
}

export function startHttpServer(port: number) {
  return Bun.serve({
    port,
    hostname: "0.0.0.0",
    async fetch(req) {
      if (req.method !== "POST") {
        return new Response("method not allowed", { status: 405 });
      }
      const body = await req.text();
      if (!body.trim()) {
        return new Response("empty body", { status: 400 });
      }

      const parsed = JSON.parse(body) as {
        sender?: string;
        room_id?: string;
        body?: string;
      };

      const meta: Record<string, string> = {};
      if (parsed.sender) meta.sender = parsed.sender;
      if (parsed.room_id) meta.room_id = parsed.room_id;

      await server.notification({
        method: "notifications/claude/channel",
        params: {
          content: parsed.body || body,
          meta,
        },
      });
      return new Response("ok");
    },
  });
}

if (import.meta.main) {
  await server.connect(new StdioServerTransport());
  const port = getPort();
  startHttpServer(port);
  process.stderr.write(
    `matrix-channel: listening on http://127.0.0.1:${port}\n`,
  );
}

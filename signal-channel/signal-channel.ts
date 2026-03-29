#!/usr/bin/env bun
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const BRIDGE_URL = process.env.SIGNAL_BRIDGE_URL ?? "http://signal:8080";

const mcp = new Server(
  { name: "signal", version: "0.0.1" },
  {
    capabilities: {
      experimental: { "claude/channel": {} },
      tools: {},
    },
    instructions:
      "Messages from Signal arrive as <channel source=\"signal\" sender=\"...\" sender_name=\"...\">. " +
      "Reply using the signal_reply tool, passing the sender from the tag as the recipient.",
  }
);

// --- Reply tool ---

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "signal_reply",
      description: "Send a message back to a Signal user",
      inputSchema: {
        type: "object" as const,
        properties: {
          recipient: {
            type: "string",
            description: "Phone number to reply to (from the sender attribute)",
          },
          text: {
            type: "string",
            description: "The message to send",
          },
        },
        required: ["recipient", "text"],
      },
    },
  ],
}));

mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
  if (req.params.name === "signal_reply") {
    const { recipient, text } = req.params.arguments as {
      recipient: string;
      text: string;
    };

    const res = await fetch(`${BRIDGE_URL}/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ recipient, message: text }),
    });

    if (!res.ok) {
      const err = await res.text();
      return { content: [{ type: "text" as const, text: `Failed to send: ${err}` }] };
    }

    return { content: [{ type: "text" as const, text: "sent" }] };
  }
  throw new Error(`unknown tool: ${req.params.name}`);
});

// --- Connect to Claude Code ---

await mcp.connect(new StdioServerTransport());

// --- SSE listener for incoming Signal messages ---

async function connectSSE() {
  while (true) {
    try {
      console.error(`Connecting to SSE at ${BRIDGE_URL}/events`);
      const res = await fetch(`${BRIDGE_URL}/events`);

      if (!res.ok || !res.body) {
        throw new Error(`SSE connection failed: ${res.status}`);
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        let newlineIdx: number;
        while ((newlineIdx = buffer.indexOf("\n\n")) !== -1) {
          const block = buffer.slice(0, newlineIdx);
          buffer = buffer.slice(newlineIdx + 2);

          for (const line of block.split("\n")) {
            if (line.startsWith("data: ")) {
              const data = line.slice(6);
              try {
                const event = JSON.parse(data);
                await mcp.notification({
                  method: "notifications/claude/channel",
                  params: {
                    content: event.message,
                    meta: {
                      sender: event.sender,
                      sender_name: event.sender_name,
                    },
                  },
                });
              } catch (e) {
                console.error("Failed to parse SSE event:", e);
              }
            }
          }
        }
      }

      console.error("SSE stream ended, reconnecting...");
    } catch (e) {
      console.error("SSE error:", e);
    }

    // Reconnect after a delay
    await new Promise((r) => setTimeout(r, 3000));
  }
}

connectSSE();

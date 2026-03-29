#!/usr/bin/env bun

const SIGNAL_ACCOUNT = process.env.SIGNAL_ACCOUNT;
const SIGNAL_ALLOWED_SENDERS = new Set(
  (process.env.SIGNAL_ALLOWED_SENDERS ?? "").split(",").map((s) => s.trim()).filter(Boolean)
);

if (!SIGNAL_ACCOUNT) {
  console.error("SIGNAL_ACCOUNT is required");
  process.exit(1);
}

if (SIGNAL_ALLOWED_SENDERS.size === 0) {
  console.error("SIGNAL_ALLOWED_SENDERS is required (comma-separated phone numbers)");
  process.exit(1);
}

// --- signal-cli JSON-RPC subprocess management ---

let signalProc: ReturnType<typeof Bun.spawn> | null = null;
let nextRpcId = 1;
const pendingRequests = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
const sseListeners = new Set<(data: string) => void>();
let restartDelay = 1000;

function spawnSignalCli() {
  console.error(`Starting signal-cli for account ${SIGNAL_ACCOUNT}`);

  signalProc = Bun.spawn(["signal-cli", "-a", SIGNAL_ACCOUNT, "jsonRpc"], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "inherit",
  });

  restartDelay = 1000;
  readLines(signalProc.stdout);

  signalProc.exited.then((code) => {
    console.error(`signal-cli exited with code ${code}, restarting in ${restartDelay}ms`);
    // Reject all pending requests
    for (const [id, { reject }] of pendingRequests) {
      reject(new Error("signal-cli exited"));
      pendingRequests.delete(id);
    }
    setTimeout(() => {
      restartDelay = Math.min(restartDelay * 2, 30000);
      spawnSignalCli();
    }, restartDelay);
  });
}

async function readLines(stdout: ReadableStream<Uint8Array>) {
  const reader = stdout.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let newlineIdx: number;
      while ((newlineIdx = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newlineIdx).trim();
        buffer = buffer.slice(newlineIdx + 1);
        if (line) handleJsonRpcLine(line);
      }
    }
  } catch (e) {
    console.error("Error reading signal-cli stdout:", e);
  }
}

function handleJsonRpcLine(line: string) {
  let msg: any;
  try {
    msg = JSON.parse(line);
  } catch {
    console.error("Failed to parse JSON-RPC line:", line);
    return;
  }

  // Response to a request we sent (has id)
  if ("id" in msg && msg.id != null) {
    const pending = pendingRequests.get(msg.id);
    if (pending) {
      pendingRequests.delete(msg.id);
      if (msg.error) {
        pending.reject(new Error(msg.error.message ?? JSON.stringify(msg.error)));
      } else {
        pending.resolve(msg.result);
      }
    }
    return;
  }

  // Notification (no id) — incoming message
  if (msg.method === "receive") {
    handleIncomingEnvelope(msg.params?.envelope);
  }
}

function handleIncomingEnvelope(envelope: any) {
  if (!envelope) return;

  const message = envelope.dataMessage?.message;
  if (!message) return; // Ignore receipts, typing indicators, etc.

  const sender = envelope.sourceNumber ?? envelope.source;
  const senderName = envelope.sourceName ?? sender;

  if (!SIGNAL_ALLOWED_SENDERS.has(sender)) {
    console.error(`Dropping message from unauthorized sender: ${sender}`);
    return;
  }

  const event = JSON.stringify({ sender, sender_name: senderName, message });
  for (const emit of sseListeners) {
    emit(event);
  }
}

async function sendSignalMessage(recipient: string, message: string): Promise<any> {
  if (!signalProc || signalProc.exitCode !== null) {
    throw new Error("signal-cli is not running");
  }

  const id = nextRpcId++;
  const request = JSON.stringify({
    jsonrpc: "2.0",
    method: "send",
    params: { recipient: [recipient], message },
    id,
  });

  return new Promise((resolve, reject) => {
    pendingRequests.set(id, { resolve, reject });
    signalProc!.stdin.write(request + "\n");
    // Timeout after 30s
    setTimeout(() => {
      if (pendingRequests.has(id)) {
        pendingRequests.delete(id);
        reject(new Error("send timed out"));
      }
    }, 30000);
  });
}

// --- HTTP server ---

spawnSignalCli();

const MAX_SIGNAL_MESSAGE_LENGTH = 2000;

Bun.serve({
  port: 8080,
  hostname: "0.0.0.0",
  idleTimeout: 0,

  async fetch(req) {
    const url = new URL(req.url);

    // SSE stream of incoming messages
    if (req.method === "GET" && url.pathname === "/events") {
      const stream = new ReadableStream({
        start(ctrl) {
          const encoder = new TextEncoder();
          ctrl.enqueue(encoder.encode(": connected\n\n"));
          const emit = (data: string) => {
            ctrl.enqueue(encoder.encode(`data: ${data}\n\n`));
          };
          sseListeners.add(emit);
          req.signal.addEventListener("abort", () => sseListeners.delete(emit));
        },
      });
      return new Response(stream, {
        headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" },
      });
    }

    // Send a message
    if (req.method === "POST" && url.pathname === "/send") {
      try {
        const body = await req.json();
        const { recipient, message } = body as { recipient: string; message: string };

        if (!recipient || !message) {
          return new Response(JSON.stringify({ error: "recipient and message required" }), {
            status: 400,
            headers: { "Content-Type": "application/json" },
          });
        }

        // Only allow sending to approved numbers
        if (!SIGNAL_ALLOWED_SENDERS.has(recipient)) {
          return new Response(JSON.stringify({ error: "recipient not in allowlist" }), {
            status: 403,
            headers: { "Content-Type": "application/json" },
          });
        }

        // Split long messages
        const chunks: string[] = [];
        for (let i = 0; i < message.length; i += MAX_SIGNAL_MESSAGE_LENGTH) {
          chunks.push(message.slice(i, i + MAX_SIGNAL_MESSAGE_LENGTH));
        }

        for (const chunk of chunks) {
          await sendSignalMessage(recipient, chunk);
        }

        return new Response(JSON.stringify({ ok: true }), {
          headers: { "Content-Type": "application/json" },
        });
      } catch (e: any) {
        return new Response(JSON.stringify({ error: e.message }), {
          status: 500,
          headers: { "Content-Type": "application/json" },
        });
      }
    }

    // Health check
    if (req.method === "GET" && url.pathname === "/health") {
      const alive = signalProc !== null && signalProc.exitCode === null;
      return new Response(JSON.stringify({ ok: alive }), {
        status: alive ? 200 : 503,
        headers: { "Content-Type": "application/json" },
      });
    }

    return new Response("not found", { status: 404 });
  },
});

console.error("Signal bridge listening on :8080");

import {
  MatrixClient,
  AutojoinRoomsMixin,
  RustSdkCryptoStorageProvider,
  SimpleFsStorageProvider,
} from "matrix-bot-sdk";

const HOMESERVER_URL = process.env.MATRIX_HOMESERVER_URL;
const ACCESS_TOKEN = process.env.MATRIX_ACCESS_TOKEN;
const ALLOWED_USER_ID = process.env.MATRIX_USER_ID;
const MATRIX_API_PORT = parseInt(process.env.MATRIX_API_PORT || "8793", 10);
const MATRIX_CHANNEL_PORT = parseInt(process.env.MATRIX_CHANNEL_PORT || "8792", 10);
const CRYPTO_DIR = process.env.MATRIX_CRYPTO_DIR || "/data/crypto";
const STORAGE_FILE = process.env.MATRIX_STORAGE_FILE || "/data/bot-storage.json";

if (!HOMESERVER_URL || !ACCESS_TOKEN || !ALLOWED_USER_ID) {
  console.error("Missing required env: MATRIX_HOMESERVER_URL, MATRIX_ACCESS_TOKEN, MATRIX_USER_ID");
  process.exit(1);
}

// Track the most recent DM room for replies
let lastRoomId: string | null = null;

// Typing indicator keepalive (Matrix typing expires after ~30s)
let typingInterval: ReturnType<typeof setInterval> | null = null;

function startTyping(roomId: string) {
  stopTyping();
  client.setTyping(roomId, true, 30000).catch(() => {});
  typingInterval = setInterval(() => {
    client.setTyping(roomId, true, 30000).catch(() => {});
  }, 25000);
}

function stopTyping() {
  if (typingInterval) {
    clearInterval(typingInterval);
    typingInterval = null;
  }
  if (lastRoomId) {
    client.setTyping(lastRoomId, false).catch(() => {});
  }
}

// Set up storage providers
const storage = new SimpleFsStorageProvider(STORAGE_FILE);
const crypto = new RustSdkCryptoStorageProvider(CRYPTO_DIR);

// Create the Matrix client with E2EE support
const client = new MatrixClient(HOMESERVER_URL, ACCESS_TOKEN, storage, crypto);
AutojoinRoomsMixin.setupOnClient(client);

// Handle incoming messages
client.on("room.message", async (roomId: string, event: any) => {
  if (!event?.content) return;
  if (event.type !== "m.room.message") return;
  // Ignore own messages
  const botUserId = await client.getUserId();
  if (event.sender === botUserId) return;
  // Only accept messages from the allowed user
  if (event.sender !== ALLOWED_USER_ID) {
    console.log(`Ignoring message from ${event.sender} (not ${ALLOWED_USER_ID})`);
    return;
  }

  const body = event.content.body;
  if (!body) return;

  lastRoomId = roomId;
  console.log(`Message from ${event.sender} in ${roomId}: ${body.slice(0, 100)}`);

  // Start typing immediately — hooks will keep it alive during tool calls
  startTyping(roomId);

  // Forward to the matrix channel inside the claude container
  try {
    await fetch(`http://claude:${MATRIX_CHANNEL_PORT}/`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sender: event.sender, room_id: roomId, body }),
    });
  } catch (err) {
    console.error(`Failed to forward message to channel:`, err);
  }
});

// HTTP API for sending messages back to Matrix
const server = Bun.serve({
  port: MATRIX_API_PORT,
  hostname: "0.0.0.0",
  async fetch(req) {
    const url = new URL(req.url);

    if (url.pathname === "/send" && req.method === "POST") {
      const { body, room_id } = (await req.json()) as {
        body: string;
        room_id?: string;
      };

      const targetRoom = room_id || lastRoomId;
      if (!targetRoom) {
        return Response.json(
          { error: "No room to send to. Send a DM to the bot first." },
          { status: 400 },
        );
      }

      if (!body?.trim()) {
        return Response.json({ error: "Empty message body" }, { status: 400 });
      }

      try {
        stopTyping();
        const eventId = await client.sendText(targetRoom, body);
        return Response.json({ ok: true, event_id: eventId });
      } catch (err: any) {
        console.error(`Failed to send message:`, err);
        return Response.json({ error: err.message }, { status: 500 });
      }
    }

    if (url.pathname === "/typing" && req.method === "POST") {
      const { typing = true, room_id } = (await req.json()) as {
        typing?: boolean;
        room_id?: string;
      };
      const targetRoom = room_id || lastRoomId;
      if (!targetRoom) {
        return Response.json({ ok: false, error: "No room" }, { status: 400 });
      }
      if (typing) {
        startTyping(targetRoom);
      } else {
        stopTyping();
      }
      return Response.json({ ok: true });
    }

    if (url.pathname === "/health" && req.method === "GET") {
      return Response.json({ ok: true, last_room: lastRoomId });
    }

    return Response.json({ error: "Not found" }, { status: 404 });
  },
});

// Start the Matrix client
await client.start();
console.log(`Matrix bot started. Listening for DMs from ${ALLOWED_USER_ID}`);
console.log(`HTTP API on 0.0.0.0:${MATRIX_API_PORT}`);

function shutdown() {
  console.log("Shutting down...");
  client.stop();
  server.stop();
  process.exit(0);
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

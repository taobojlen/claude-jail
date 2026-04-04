import { describe, test, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { server, startHttpServer } from "./scheduler-channel.ts";

describe("scheduler-channel", () => {
  test("declares claude/channel capability", () => {
    const capabilities = server.getCapabilities();
    expect(capabilities.experimental?.["claude/channel"]).toEqual({});
  });

  describe("HTTP server", () => {
    let httpServer: ReturnType<typeof Bun.serve>;
    let notificationSpy: ReturnType<typeof spyOn>;
    const TEST_PORT = 18790;

    beforeEach(() => {
      notificationSpy = spyOn(server, "notification").mockResolvedValue(undefined as any);
      httpServer = startHttpServer(TEST_PORT);
    });

    afterEach(() => {
      httpServer.stop(true);
      notificationSpy.mockRestore();
    });

    test("POST forwards body as channel notification", async () => {
      const res = await fetch(`http://127.0.0.1:${TEST_PORT}/`, {
        method: "POST",
        body: "Analyze the data and send me a summary",
      });

      expect(res.status).toBe(200);
      expect(notificationSpy).toHaveBeenCalledWith({
        method: "notifications/claude/channel",
        params: {
          content: "Analyze the data and send me a summary",
          meta: {},
        },
      });
    });

    test("passes X-Task-Id and X-Task-Name headers as meta", async () => {
      const res = await fetch(`http://127.0.0.1:${TEST_PORT}/`, {
        method: "POST",
        headers: {
          "X-Task-Id": "daily-analysis",
          "X-Task-Name": "Daily Analysis",
        },
        body: "Do the analysis",
      });

      expect(res.status).toBe(200);
      expect(notificationSpy).toHaveBeenCalledWith({
        method: "notifications/claude/channel",
        params: {
          content: "Do the analysis",
          meta: {
            task_id: "daily-analysis",
            task_name: "Daily Analysis",
          },
        },
      });
    });

    test("returns 400 for empty body", async () => {
      const res = await fetch(`http://127.0.0.1:${TEST_PORT}/`, {
        method: "POST",
        body: "",
      });

      expect(res.status).toBe(400);
      expect(notificationSpy).not.toHaveBeenCalled();
    });

    test("returns 405 for non-POST methods", async () => {
      const res = await fetch(`http://127.0.0.1:${TEST_PORT}/`);

      expect(res.status).toBe(405);
      expect(notificationSpy).not.toHaveBeenCalled();
    });
  });

  test("port is configurable via SCHEDULER_CHANNEL_PORT env var", () => {
    const { getPort } = require("./scheduler-channel.ts");
    const original = process.env.SCHEDULER_CHANNEL_PORT;
    try {
      process.env.SCHEDULER_CHANNEL_PORT = "9999";
      expect(getPort()).toBe(9999);
    } finally {
      if (original === undefined) delete process.env.SCHEDULER_CHANNEL_PORT;
      else process.env.SCHEDULER_CHANNEL_PORT = original;
    }
  });

  test("defaults to port 8790", () => {
    const { getPort } = require("./scheduler-channel.ts");
    const original = process.env.SCHEDULER_CHANNEL_PORT;
    try {
      delete process.env.SCHEDULER_CHANNEL_PORT;
      expect(getPort()).toBe(8790);
    } finally {
      if (original !== undefined) process.env.SCHEDULER_CHANNEL_PORT = original;
    }
  });

  test("HTTP server binds to localhost only", () => {
    const spy = spyOn(server, "notification").mockResolvedValue(undefined as any);
    const httpServer = startHttpServer(18791);
    try {
      expect(httpServer.hostname).toBe("0.0.0.0");
    } finally {
      httpServer.stop(true);
      spy.mockRestore();
    }
  });

  test("declares tools capability", () => {
    const capabilities = server.getCapabilities();
    expect(capabilities.tools).toEqual({});
  });
});

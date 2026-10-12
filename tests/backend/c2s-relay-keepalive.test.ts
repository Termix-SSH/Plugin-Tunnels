import { EventEmitter } from "node:events";
import type { WebSocket } from "ws";
import { afterEach, describe, expect, it, vi } from "vitest";
import { keepRelayAlive } from "../../src/backend/c2s-relay.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("keepRelayAlive", () => {
  it("pings an open relay socket until it closes", () => {
    vi.useFakeTimers();
    const ws = Object.assign(new EventEmitter(), {
      readyState: 1,
      ping: vi.fn(),
    });
    keepRelayAlive(ws as unknown as WebSocket, 1000);

    vi.advanceTimersByTime(3000);
    expect(ws.ping).toHaveBeenCalledTimes(3);

    ws.emit("close");
    vi.advanceTimersByTime(5000);
    expect(ws.ping).toHaveBeenCalledTimes(3);
  });
});

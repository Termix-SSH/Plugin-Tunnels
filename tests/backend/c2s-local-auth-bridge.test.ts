import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WebSocket } from "ws";
import { createAuthBridge } from "../../src/backend/c2s-local/auth-bridge";

function setup(hasWindow = true) {
  const window = {};
  const delivered: unknown[] = [];
  const bridge = createAuthBridge({
    deliver: (event) => {
      delivered.push(event);
      return event.type === "auth-prompt" && !hasWindow ? null : window;
    },
  });
  const ws = Object.assign(new EventEmitter(), {
    readyState: 1,
    send: vi.fn(),
    close: vi.fn(() => {
      ws.readyState = 3;
      ws.emit("close");
    }),
  });
  bridge.attach(ws as unknown as WebSocket, "dynamic");
  const prompt = () =>
    ws.emit(
      "message",
      Buffer.from(
        JSON.stringify({
          type: "auth-prompt",
          requestId: "server-challenge",
          request: { kind: "totp", prompt: "Code:", retry: false },
        }),
      ),
      false,
    );
  return { bridge, ws, window, delivered, prompt };
}

afterEach(() => vi.useRealTimers());

describe("desktop tunnel prompt bridge", () => {
  it("binds answers to the challenge and rejects replay", () => {
    const { bridge, ws, delivered, prompt } = setup();
    prompt();
    const id = (delivered[0] as { id: string }).id;
    expect(bridge.answer("unknown", "123456")).toBe(false);
    expect(bridge.answer(id, { secret: "bad" })).toBe(false);
    expect(ws.send).not.toHaveBeenCalled();
    expect(bridge.answer(id, "123456")).toBe(true);
    expect(JSON.parse(ws.send.mock.calls[0][0])).toEqual({
      type: "auth-response",
      requestId: "server-challenge",
      answer: "123456",
    });
    expect(bridge.answer(id, "again")).toBe(false);
    ws.close();
  });

  it("closes the relay when no window can show the prompt", () => {
    const { ws, prompt } = setup(false);
    prompt();
    expect(ws.close).toHaveBeenCalled();
  });

  it.each(["close", "window", "timeout"])(
    "clears a pending prompt on %s",
    (reason) => {
      vi.useFakeTimers();
      const { bridge, ws, window, delivered, prompt } = setup();
      prompt();
      const id = (delivered[0] as { id: string }).id;
      if (reason === "close") ws.close();
      else if (reason === "window") bridge.dropTarget(window);
      else vi.advanceTimersByTime(60_000);
      expect(delivered.at(-1)).toEqual({ type: "auth-prompt-closed", id });
      expect(bridge.answer(id, "late")).toBe(false);
      expect(ws.close).toHaveBeenCalled();
    },
  );
});

import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import type { WebSocket } from "ws";
import { createMockCtx } from "@termix-ssh/plugin-sdk/testing";
import { createC2SRelay } from "../../src/backend/c2s-relay.js";
import { host, manifest } from "./helpers.js";

class Socket extends EventEmitter {
  readyState = 1;
  send = vi.fn();
  close() {
    this.readyState = 3;
    this.emit("close");
  }
  message(value: unknown) {
    this.emit("message", Buffer.from(JSON.stringify(value)), false);
  }
  get ws() {
    return this as unknown as WebSocket;
  }
  messages() {
    return this.send.mock.calls.map(([data]) => JSON.parse(String(data)));
  }
}

describe("remote client tunnels on one shared connection", () => {
  it("lets each tunnel take only its own port and cleans up its listeners", async () => {
    const mock = createMockCtx({
      pluginId: "tunnels",
      manifest,
      capabilities: manifest.capabilities,
      permissions: ["tunnels.use"],
      hosts: [host()],
    });
    const client = Object.assign(new EventEmitter(), {
      forwardIn: vi.fn(
        (_h: string, port: number, cb: (e?: Error, p?: number) => void) =>
          cb(undefined, port),
      ),
      unforwardIn: vi.fn((_h: string, _p: number, cb?: () => void) => cb?.()),
    });
    mock.ctx.ssh.connect = (async () => ({
      client,
      dispose: vi.fn(),
      host: host(),
      jumpClient: null,
    })) as unknown as typeof mock.ctx.ssh.connect;
    const handle = createC2SRelay(mock.ctx);
    const open = (port: number) => {
      const socket = new Socket();
      handle(socket.ws, "user-1");
      socket.message({
        type: "open",
        tunnelConfig: {
          sourceHostId: 7,
          mode: "remote",
          sourcePort: port,
          sessionId: "desktop",
        },
      });
      return socket;
    };

    const first = open(8001);
    const second = open(8002);
    await vi.waitFor(() => {
      expect(first.messages().at(-1)?.type).toBe("ready");
      expect(second.messages().at(-1)?.type).toBe("ready");
    });

    const reject = vi.fn();
    const accept = vi.fn(() => new PassThrough());
    client.emit("tcp connection", { destPort: 8002 }, accept, reject);
    expect(reject).not.toHaveBeenCalled();
    expect(accept).toHaveBeenCalledOnce();
    expect(second.messages().at(-1)?.type).toBe("connection");

    first.close();
    second.close();
    expect(client.listenerCount("tcp connection")).toBe(0);
    for (const cleanup of mock.disposals) await cleanup();
  });
});

describe("local client tunnel errors", () => {
  it("says which target the endpoint host could not reach", async () => {
    const mock = createMockCtx({
      pluginId: "tunnels",
      manifest,
      capabilities: manifest.capabilities,
      permissions: ["tunnels.use"],
      hosts: [host()],
    });
    const client = Object.assign(new EventEmitter(), {
      forwardOut: vi.fn(
        (
          _sh: string,
          _sp: number,
          _th: string,
          _tp: number,
          cb: (e?: Error) => void,
        ) => cb(new Error("(SSH) Channel open failure: Connection refused")),
      ),
    });
    mock.ctx.ssh.connect = (async () => ({
      client,
      dispose: vi.fn(),
      host: host(),
      jumpClient: null,
    })) as unknown as typeof mock.ctx.ssh.connect;
    const socket = new Socket();
    createC2SRelay(mock.ctx)(socket.ws, "user-1");
    socket.message({
      type: "test",
      tunnelConfig: { sourceHostId: 7, mode: "local", endpointPort: 8443 },
    });

    await vi.waitFor(() =>
      expect(socket.messages().at(-1)?.type).toBe("error"),
    );
    const error = socket.messages().at(-1)?.error as string;
    expect(error).toContain("not reachable from the endpoint host");
    expect(error).toContain("127.0.0.1:8443");
  });
});

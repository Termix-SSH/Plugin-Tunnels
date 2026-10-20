import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import type { WebSocket } from "ws";
import {
  createC2SRuntime,
  keepSocketAlive,
} from "../../src/backend/c2s-local/runtime";

class Socket extends EventEmitter {
  readyState = 1;
  send = vi.fn();
  close = vi.fn(() => {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.emit("close");
  });
  ready() {
    this.emit("message", Buffer.from(JSON.stringify({ type: "ready" })), false);
  }
}

function setup(link: unknown = defaultLink) {
  const sockets: Socket[] = [];
  const urls: string[] = [];
  let incoming!: (socket: EventEmitter) => void;
  const server = Object.assign(new EventEmitter(), {
    listen: (_options: unknown, ready?: () => void) => {
      if (ready) ready();
      else queueMicrotask(() => server.emit("listening"));
    },
    close: vi.fn((done?: () => void) => done?.()),
  });
  const attachAuth = vi.fn();
  const statuses = vi.fn();
  const runtime = createC2SRuntime({
    getLink: async () => link as never,
    linkJson: async () => ({ id: 9, name: "jump" }),
    relayPath: "/plugin-ws/tunnels/c2s/stream",
    attachAuth,
    onStatuses: statuses,
    log: vi.fn(),
    createWebSocket: (url) => {
      const socket = new Socket();
      sockets.push(socket);
      urls.push(url);
      setTimeout(() => socket.emit("open"), 0);
      return socket as unknown as WebSocket;
    },
    netImpl: {
      createServer: ((callback: typeof incoming) => {
        if (typeof callback === "function") incoming = callback;
        return server;
      }) as never,
      createConnection: vi.fn() as never,
    },
  });
  return {
    runtime,
    sockets,
    urls,
    server,
    attachAuth,
    statuses,
    incoming: () => incoming,
  };
}

const defaultLink = {
  serverUrl: "https://server.example/termix/",
  token: "jwt",
  headers: { Cookie: "jwt=jwt" },
  allowInvalidCertificate: false,
};

describe("client tunnel runtime", () => {
  it("holds the preflight open, refuses early connections and stops cleanly", async () => {
    const { runtime, sockets, urls, server, attachAuth, incoming } = setup();
    const tunnel = {
      name: "socks",
      mode: "dynamic",
      sourceHostId: 7,
      sourcePort: 1080,
    };
    await runtime.start(tunnel, 0);
    await vi.waitFor(() => expect(sockets).toHaveLength(1));
    await vi.waitFor(() => expect(sockets[0].send).toHaveBeenCalled());
    expect(urls[0]).toBe(
      "wss://server.example/termix/plugin-ws/tunnels/c2s/stream",
    );
    expect(attachAuth).toHaveBeenCalledWith(sockets[0], "socks");

    const premature = Object.assign(new EventEmitter(), { destroy: vi.fn() });
    incoming()(premature);
    expect(premature.destroy).toHaveBeenCalledOnce();
    expect(JSON.parse(sockets[0].send.mock.calls[0][0])).toMatchObject({
      type: "test",
      keepAlive: true,
      tunnelConfig: { sessionId: expect.any(String) },
    });

    sockets[0].ready();
    await vi.waitFor(() =>
      expect(runtime.runtimes.get("socks")?.status.connected).toBe(true),
    );
    expect(sockets[0].close).not.toHaveBeenCalled();

    await runtime.stop("socks");
    expect(sockets[0].readyState).toBe(3);
    expect(server.close).toHaveBeenCalled();
    expect(runtime.runtimes.size).toBe(0);
  });

  it("does not retain a socket for a standalone test or a stopped runtime", async () => {
    const { runtime, sockets } = setup();
    const test = runtime.testRelay({ name: "test" });
    await vi.waitFor(() => expect(sockets).toHaveLength(1));
    sockets[0].ready();
    expect(await test).toEqual({ success: true });
    expect(sockets[0].close).toHaveBeenCalledOnce();
    expect(
      await runtime.testRelay(
        { name: "stopped" },
        undefined,
        undefined,
        {} as never,
      ),
    ).toEqual({ success: false, error: "Tunnel stopped" });
    expect(sockets).toHaveLength(1);
  });

  it("keeps the relay's reason when it closes after an error", async () => {
    const { runtime, sockets } = setup();
    const entry = {
      status: { connected: true, status: "CONNECTED" },
      sockets: new Set(),
      sourcePort: 1,
      bindHost: "127.0.0.1",
    };
    runtime.runtimes.set("web", entry as never);
    const test = runtime.testRelay(
      { name: "web" },
      "127.0.0.1",
      8443,
      entry as never,
    );
    await vi.waitFor(() => expect(sockets).toHaveLength(1));
    sockets[0].emit(
      "message",
      Buffer.from(
        JSON.stringify({
          type: "error",
          error: "Target 127.0.0.1:8443 refused",
        }),
      ),
      false,
    );
    sockets[0].close();
    expect(await test).toMatchObject({ success: false });
    expect(runtime.runtimes.get("web")?.status.reason).toBe(
      "Target 127.0.0.1:8443 refused",
    );
  });

  it("keeps the tunnel connected when one connection fails, but not on a signed out error", async () => {
    const { runtime, sockets } = setup();
    runtime.runtimes.set("web", {
      status: { connected: true, status: "CONNECTED" },
      sockets: new Set(),
      sourcePort: 1,
      bindHost: "127.0.0.1",
    } as never);
    const local = () =>
      Object.assign(new EventEmitter(), { destroy: vi.fn(), write: vi.fn() });

    const first = local();
    await runtime.openRelay({ name: "web" }, "127.0.0.1", 8006, first as never);
    await vi.waitFor(() => expect(sockets).toHaveLength(1));
    first.emit("error", new Error("ECONNRESET"));
    sockets[0].emit(
      "message",
      Buffer.from(JSON.stringify({ type: "error", error: "refused" })),
      false,
    );
    expect(runtime.runtimes.get("web")?.status.connected).toBe(true);

    await runtime.openRelay(
      { name: "web" },
      "127.0.0.1",
      8006,
      local() as never,
    );
    await vi.waitFor(() => expect(sockets).toHaveLength(2));
    sockets[1].emit(
      "message",
      Buffer.from(JSON.stringify({ type: "error", error: "session expired" })),
      false,
    );
    expect(runtime.runtimes.get("web")?.status).toMatchObject({
      connected: false,
      status: "ERROR",
    });
  });

  it("shows a clear status when the device is not linked or signed out", async () => {
    const unlinked = setup(null);
    await unlinked.runtime.start(
      { name: "a", mode: "dynamic", sourceHostId: 1, sourcePort: 1081 },
      0,
    );
    await vi.waitFor(() =>
      expect(unlinked.runtime.runtimes.get("a")?.status).toMatchObject({
        status: "ERROR",
        reason: expect.stringContaining("not linked"),
      }),
    );

    const signedOut = setup({ ...defaultLink, token: null });
    await signedOut.runtime.start(
      { name: "b", mode: "dynamic", sourceHostId: 1, sourcePort: 1082 },
      0,
    );
    await vi.waitFor(() =>
      expect(signedOut.runtime.runtimes.get("b")?.status).toMatchObject({
        status: "ERROR",
        reason: expect.stringContaining("signed out"),
      }),
    );
  });

  it("refuses a second tunnel on the same local address", async () => {
    const { runtime } = setup();
    await runtime.start(
      { name: "one", mode: "dynamic", sourceHostId: 1, sourcePort: 1090 },
      0,
    );
    const second = await runtime.start(
      { name: "two", mode: "dynamic", sourceHostId: 1, sourcePort: 1090 },
      1,
    );
    expect(second).toMatchObject({
      success: false,
      error: expect.stringContaining("already uses"),
    });
  });

  it("resolves the endpoint host through the server by its sync id", async () => {
    const { runtime, sockets } = setup();
    await runtime.start(
      {
        name: "synced",
        mode: "dynamic",
        sourceHostSyncId: "abc",
        sourceHostId: 1,
        sourcePort: 1095,
      },
      0,
    );
    await vi.waitFor(() => expect(sockets).toHaveLength(1));
    await vi.waitFor(() => expect(sockets[0].send).toHaveBeenCalled());
    expect(
      JSON.parse(sockets[0].send.mock.calls[0][0]).tunnelConfig.sourceHostId,
    ).toBe(9);
  });
});

describe("client tunnel socket keepalive", () => {
  it("pings an open socket until it closes", () => {
    vi.useFakeTimers();
    try {
      const ws = Object.assign(new EventEmitter(), {
        readyState: 1,
        ping: vi.fn(),
      });
      keepSocketAlive(ws as unknown as WebSocket, 25_000);
      vi.advanceTimersByTime(50_000);
      expect(ws.ping).toHaveBeenCalledTimes(2);
      ws.emit("close");
      vi.advanceTimersByTime(50_000);
      expect(ws.ping).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

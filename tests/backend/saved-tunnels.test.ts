import { afterEach, describe, expect, it, vi } from "vitest";
import type { PluginContext } from "@termix-ssh/plugin-sdk/backend";
import { moveLegacyTunnels } from "../../src/backend/legacy-move.js";
import type { SavedTunnelStore } from "../../src/backend/saved-store.js";
import type { TunnelConnection } from "../../src/backend/types.js";
import { host, startServer, type TestServer } from "./helpers";

let server: TestServer | null = null;

afterEach(async () => {
  await server?.close();
  server = null;
});

const tunnel = (overrides: Record<string, unknown> = {}): TunnelConnection => ({
  scope: "s2s",
  mode: "local",
  sourcePort: 8080,
  endpointHost: "db",
  endpointPort: 5432,
  maxRetries: 3,
  retryInterval: 10,
  autoStart: false,
  ...overrides,
});

async function start() {
  const started = await startServer({
    hosts: { "user-1": [host()], "user-2": [] },
  });
  // The saved tunnel table points at real host rows.
  started.db.sqlite.exec("INSERT INTO ssh_data (id) VALUES (7)");
  return started;
}

describe("saved tunnel routes", () => {
  it("saves a host's list, lists it back and clears it", async () => {
    server = await start();

    const saved = await server.request("PUT", "/saved/7", {
      body: { connections: [tunnel(), tunnel({ sourcePort: 9090 })] },
    });
    expect(saved.status).toBe(200);

    const listed = await server.request("GET", "/saved");
    expect(listed.body).toEqual([
      { hostId: 7, connections: [tunnel(), tunnel({ sourcePort: 9090 })] },
    ]);

    await server.request("PUT", "/saved/7", { body: { connections: [] } });
    expect((await server.request("GET", "/saved")).body).toEqual([]);
  });

  it("hides a host's tunnels from a user who cannot reach it", async () => {
    server = await start();
    await server.request("PUT", "/saved/7", {
      body: { connections: [tunnel()] },
    });

    expect(
      (await server.request("GET", "/saved", { user: "user-2" })).body,
    ).toEqual([]);
    const denied = await server.request("PUT", "/saved/7", {
      user: "user-2",
      body: { connections: [] },
    });
    expect(denied.status).toBe(403);
  });

  it("rejects tunnels with a bad mode or port", async () => {
    server = await start();
    for (const bad of [
      tunnel({ mode: "sideways" }),
      tunnel({ sourcePort: 0 }),
      tunnel({ endpointPort: 70000 }),
      tunnel({ scope: "c2s" }),
    ]) {
      const response = await server.request("PUT", "/saved/7", {
        body: { connections: [bad] },
      });
      expect(response.status).toBe(400);
    }
  });
});

describe("old clients", () => {
  it("moves a tunnel list an old client saves as a host setting", async () => {
    server = await start();
    const { mock } = server;
    mock.setActor("user-1");

    await mock.ctx.settings.setHost(7, "tunnelConnections", [tunnel()]);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect((await server.request("GET", "/saved")).body).toEqual([
      { hostId: 7, connections: [tunnel()] },
    ]);
    expect(await mock.ctx.settings.getHost(7, "tunnelConnections")).toEqual([]);

    await mock.ctx.settings.setHost(7, "tunnelConnections", [
      tunnel({ sourcePort: 2222 }),
    ]);
    await new Promise((resolve) => setTimeout(resolve, 50));
    const listed = (await server.request("GET", "/saved")).body;
    expect(listed[0].connections[0].sourcePort).toBe(2222);
  });
});

describe("moving old host settings", () => {
  it("moves a host once and leaves a host that already has a row", async () => {
    const value = [tunnel()];
    const setHost = vi.fn(async () => {});
    const set = vi.fn(async () => {});
    const ctx = {
      settings: {
        listHostValues: async () => [
          { hostId: 7, userId: "user-1", value },
          { hostId: 8, userId: "user-1", value },
          { hostId: 9, userId: "user-1", value: [] },
          { hostId: 10, userId: "", value },
        ],
        setHost,
      },
      log: { warn: vi.fn(), info: vi.fn() },
    } as unknown as PluginContext;
    const store = {
      get: async (hostId: number) => (hostId === 8 ? { hostId } : null),
      set,
    } as unknown as SavedTunnelStore;

    expect(await moveLegacyTunnels(ctx, store)).toBe(1);
    expect(set).toHaveBeenCalledTimes(1);
    expect(set).toHaveBeenCalledWith(7, "user-1", value);
    expect(setHost).toHaveBeenCalledTimes(2);

    set.mockClear();
    expect(await moveLegacyTunnels(ctx, store, true)).toBe(2);
    expect(set).toHaveBeenCalledTimes(2);
  });
});

import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readCommand } from "../../src/backend/x11-apps.js";
import { startServer, type TestServer } from "./helpers";

let server: TestServer | null = null;

afterEach(async () => {
  await server?.close();
  server = null;
});

class FakeChannel extends EventEmitter {
  stderr = new EventEmitter();
  close = vi.fn(() => this.emit("close"));
}

/** An ssh2 client whose exec records its options and hands back a channel. */
function fakeConnection(refuseX11 = false) {
  const channel = new FakeChannel();
  const client = new EventEmitter() as EventEmitter & {
    exec: (...args: unknown[]) => void;
    calls: unknown[][];
  };
  client.calls = [];
  client.exec = (...args: unknown[]) => {
    client.calls.push(args);
    const callback = args[args.length - 1] as (
      err: Error | undefined,
      stream?: FakeChannel,
    ) => void;
    if (refuseX11) callback(new Error("Unable to request X11"));
    else callback(undefined, channel);
  };
  const dispose = vi.fn();
  return { client, channel, dispose };
}

describe("readCommand", () => {
  it("takes one line", () => {
    expect(readCommand("  xclock -digital ")).toBe("xclock -digital");
    expect(() => readCommand("")).toThrow();
    expect(() => readCommand("xclock\nrm -rf /")).toThrow(/one line/);
    expect(() => readCommand("x".repeat(1001))).toThrow(/too long/);
  });
});

describe("x11 app routes", () => {
  it("says when no X server is set and refuses to start", async () => {
    server = await startServer();
    const list = await server.request("GET", "/x11/apps");
    expect(list.body).toEqual({ configured: false, apps: [] });
    const start = await server.request("POST", "/x11/apps", {
      body: { hostId: 7, command: "xclock" },
    });
    expect(start.status).toBe(409);
  });

  it("starts a program with X11 on, lists it and stops it", async () => {
    server = await startServer();
    await server.mock.ctx.settings.set("x11Display", "localhost:0.1");
    const fake = fakeConnection();
    server.mock.ctx.ssh.connect = (async () => ({
      client: fake.client,
      dispose: fake.dispose,
    })) as never;

    const start = await server.request("POST", "/x11/apps", {
      body: { hostId: 7, command: "xclock" },
    });
    expect(start.status).toBe(200);
    expect(start.body).toMatchObject({
      hostName: "web",
      command: "xclock",
      running: true,
    });
    expect(fake.client.calls[0][0]).toBe("xclock");
    expect(fake.client.calls[0][1]).toEqual({
      x11: { single: false, screen: 1 },
    });
    expect(fake.client.listenerCount("x11")).toBe(1);

    const other = await server.request("GET", "/x11/apps", { user: "user-2" });
    expect(other.body.apps).toEqual([]);
    const notMine = await server.request(
      "DELETE",
      `/x11/apps/${start.body.id}`,
      { user: "user-2" },
    );
    expect(notMine.status).toBe(404);

    fake.channel.emit("data", Buffer.from("Warning: something\n"));
    const stop = await server.request("DELETE", `/x11/apps/${start.body.id}`);
    expect(stop.status).toBe(200);
    expect(fake.channel.close).toHaveBeenCalled();
    expect(fake.dispose).toHaveBeenCalled();
    expect(fake.client.listenerCount("x11")).toBe(0);
  });

  it("explains a host that refuses X11", async () => {
    server = await startServer();
    await server.mock.ctx.settings.set("x11Display", "localhost:0");
    const fake = fakeConnection(true);
    server.mock.ctx.ssh.connect = (async () => ({
      client: fake.client,
      dispose: fake.dispose,
    })) as never;
    const start = await server.request("POST", "/x11/apps", {
      body: { hostId: 7, command: "xclock" },
    });
    expect(start.status).toBe(422);
    expect(start.body.error).toMatch(/X11Forwarding yes/);
    expect(fake.dispose).toHaveBeenCalled();
  });

  it("refuses a host the caller can't see", async () => {
    server = await startServer();
    await server.mock.ctx.settings.set("x11Display", "localhost:0");
    const start = await server.request("POST", "/x11/apps", {
      body: { hostId: 99, command: "xclock" },
    });
    expect(start.status).toBe(404);
  });
});

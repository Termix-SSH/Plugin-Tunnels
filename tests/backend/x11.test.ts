import net, { type AddressInfo } from "node:net";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  bridgeX11,
  connectDisplay,
  parseDisplay,
} from "../../src/backend/x11.js";

describe("parseDisplay", () => {
  it("reads TCP displays", () => {
    expect(parseDisplay("localhost:0")).toEqual({
      host: "localhost",
      port: 6000,
      screen: 0,
    });
    expect(parseDisplay("192.168.1.5:10.1")).toEqual({
      host: "192.168.1.5",
      port: 6010,
      screen: 1,
    });
    expect(parseDisplay("[::1]:2")).toMatchObject({ host: "::1", port: 6002 });
  });

  it("uses the unix socket for :N except on Windows", () => {
    expect(parseDisplay(":1", "linux")).toEqual({
      host: "",
      port: 0,
      screen: 0,
      socketPath: "/tmp/.X11-unix/X1",
    });
    expect(parseDisplay(":0", "win32")).toEqual({
      host: "127.0.0.1",
      port: 6000,
      screen: 0,
    });
  });

  it("is off when empty or not a display", () => {
    expect(parseDisplay("")).toBeNull();
    expect(parseDisplay(undefined)).toBeNull();
    expect(parseDisplay("localhost")).toBeNull();
    expect(parseDisplay("a b:0")).toBeNull();
    expect(parseDisplay("host:123")).toBeNull();
  });
});

class FakeClient extends EventEmitter {}

describe("bridgeX11", () => {
  let server: net.Server | null = null;

  afterEach(async () => {
    await new Promise<void>((resolve) =>
      server ? server.close(() => resolve()) : resolve(),
    );
    server = null;
  });

  it("pipes an X11 channel to the X server both ways", async () => {
    server = net.createServer((socket) => {
      socket.on("error", () => {});
      socket.on("data", (data) => socket.write(`echo:${data.toString()}`));
    });
    await new Promise<void>((resolve) =>
      server!.listen(0, "127.0.0.1", resolve),
    );
    const port = (server.address() as AddressInfo).port;
    const client = new FakeClient();
    const stop = bridgeX11(client as never, {
      host: "127.0.0.1",
      port,
      screen: 0,
    });
    const channel = new PassThrough();
    const got = new Promise<string>((resolve) =>
      channel.once("data", (data: Buffer) => resolve(data.toString())),
    );
    let accepted = false;
    client.emit(
      "x11",
      {},
      () => {
        accepted = true;
        return channel;
      },
      () => {},
    );
    await vi.waitFor(() => expect(accepted).toBe(true));
    channel.write("hi");
    // The echo comes back through the same duplex channel.
    expect(await got).toMatch(/hi/);
    stop();
    expect(client.listenerCount("x11")).toBe(0);
  });

  it("rejects the channel when the X server is not there", async () => {
    const client = new FakeClient();
    const onError = vi.fn();
    const reject = vi.fn();
    bridgeX11(
      client as never,
      { host: "127.0.0.1", port: 1, screen: 0 },
      onError,
      () => Promise.reject(new Error("refused")),
    );
    client.emit("x11", {}, () => new PassThrough(), reject);
    await vi.waitFor(() => expect(reject).toHaveBeenCalled());
    expect(onError).toHaveBeenCalled();
  });

  it("allows the admin's private X server address", async () => {
    server = net.createServer();
    await new Promise<void>((resolve) =>
      server!.listen(0, "127.0.0.1", resolve),
    );
    const port = (server.address() as AddressInfo).port;
    const socket = await connectDisplay({ host: "127.0.0.1", port, screen: 0 });
    expect(socket.remotePort).toBe(port);
    socket.destroy();
  });
});

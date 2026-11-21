import net from "node:net";
import { resolveTarget } from "@termix-ssh/plugin-sdk/net-guard";

/** Where the X server that shows forwarded windows listens. */
export interface X11Display {
  /** Empty for a local unix socket. */
  host: string;
  port: number;
  screen: number;
  socketPath?: string;
}

const DISPLAY_RE = /^([A-Za-z0-9_.\-[\]:]*?):(\d{1,2})(?:\.(\d{1,2}))?$/;
const MAX_CHANNELS = 64;

/**
 * Reads an X display like "localhost:0", "127.0.0.1:1.0", ":0" or "unix:0".
 * Null when empty or not valid.
 */
export function parseDisplay(
  value: unknown,
  platform: NodeJS.Platform = process.platform,
): X11Display | null {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) return null;
  const match = DISPLAY_RE.exec(text);
  if (!match) return null;
  const display = Number(match[2]);
  const screen = Number(match[3] ?? 0);
  const rawHost = match[1].replace(/^\[|\]$/g, "");
  if ((rawHost === "" || rawHost === "unix") && platform !== "win32") {
    return {
      host: "",
      port: 0,
      screen,
      socketPath: `/tmp/.X11-unix/X${display}`,
    };
  }
  return {
    host: rawHost === "" || rawHost === "unix" ? "127.0.0.1" : rawHost,
    port: 6000 + display,
    screen,
  };
}

interface X11Channel {
  pipe: (target: NodeJS.WritableStream) => NodeJS.WritableStream;
  on: (event: string, fn: (...args: unknown[]) => void) => unknown;
  destroy?: () => void;
  close?: () => void;
}

interface X11Client {
  on: (
    event: "x11",
    fn: (info: unknown, accept: () => X11Channel, reject: () => void) => void,
  ) => unknown;
  removeListener: (event: "x11", fn: (...args: never[]) => void) => unknown;
}

type Connect = (display: X11Display) => Promise<net.Socket>;

/** Opens a socket to the X server. The admin picked it, so it may be private. */
export async function connectDisplay(display: X11Display): Promise<net.Socket> {
  let options: net.NetConnectOpts;
  if (display.socketPath) {
    options = { path: display.socketPath };
  } else {
    const target = await resolveTarget(display.host, {
      allowPrivateHosts: [display.host],
    });
    options = { host: target.address, port: display.port };
  }
  return new Promise((resolve, reject) => {
    const socket = net.connect(options);
    socket.setNoDelay(true);
    socket.once("connect", () => resolve(socket));
    socket.once("error", reject);
  });
}

/**
 * Sends X11 channels the host opens to the X server. Returns a function
 * that stops listening and closes open channels.
 */
export function bridgeX11(
  client: X11Client,
  display: X11Display,
  onError: (error: unknown) => void = () => {},
  connect: Connect = connectDisplay,
): () => void {
  const open = new Set<() => void>();
  const listener = (
    _info: unknown,
    accept: () => X11Channel,
    reject: () => void,
  ) => {
    if (open.size >= MAX_CHANNELS) {
      reject();
      return;
    }
    connect(display).then(
      (socket) => {
        const channel = accept();
        const end = () => {
          open.delete(end);
          socket.destroy();
          channel.close?.();
        };
        open.add(end);
        channel.pipe(socket);
        socket.pipe(channel as unknown as NodeJS.WritableStream);
        socket.on("close", end);
        socket.on("error", end);
        channel.on("close", end);
        channel.on("error", end);
      },
      (error) => {
        onError(error);
        reject();
      },
    );
  };
  client.on("x11", listener);
  return () => {
    client.removeListener("x11", listener as never);
    for (const end of [...open]) end();
  };
}

import { randomUUID } from "node:crypto";
import net from "node:net";
import type { Socket } from "node:net";
import { WebSocket } from "ws";
import {
  SESSION_EXPIRED_ERROR,
  failure,
  localAddress,
  normalizeAddresses,
  normalizeError,
  parseSocks5Target,
  remoteAddress,
  tunnelMode,
  tunnelName as nameOf,
  type C2SFailure,
  type C2STunnel,
} from "./addresses.js";

/** What the desktop knows about the server it is linked to. */
export interface LinkInfo {
  serverUrl: string;
  token: string | null;
  headers: Record<string, string>;
  allowInvalidCertificate: boolean;
}

export interface TunnelStatus {
  connected: boolean;
  status: string;
  reason?: string;
}

export interface C2SRuntimeDeps {
  getLink: () => Promise<LinkInfo | null>;
  linkJson: (pathname: string) => Promise<unknown>;
  /** The relay socket's path on the linked server. */
  relayPath: string;
  attachAuth: (ws: WebSocket, tunnelName: string) => void;
  onStatuses: (statuses: Record<string, TunnelStatus>) => void;
  log: (message: string, data?: unknown) => void;
  /** Test seams. */
  createWebSocket?: (
    url: string,
    options: { headers: Record<string, string>; rejectUnauthorized?: boolean },
  ) => WebSocket;
  netImpl?: Pick<typeof net, "createServer" | "createConnection">;
}

interface Runtime {
  server?: net.Server;
  ws?: WebSocket;
  authSocket?: WebSocket;
  sockets: Set<Socket> | Map<string, Socket>;
  mode?: string;
  sourceHostId?: number;
  sourcePort: number;
  bindHost: string;
  remoteAddress?: string;
  status: TunnelStatus;
  close?: () => void;
}

const WS_HIGH_WATERMARK = 1024 * 1024;
const WS_LOW_WATERMARK = 256 * 1024;
const STREAM_WRITE_LIMIT = 8 * 1024 * 1024;
const PING_MS = 25_000;
const TEST_TIMEOUT_MS = 180_000;

export type StartResult =
  | { success: true; tunnelName: string }
  | C2SFailure
  | { success: false; error: string };

export type TestResult =
  { success: true } | C2SFailure | { success: false; error: string };

export function checkLocalPortAvailable(
  host: string,
  port: number,
  netImpl: Pick<typeof net, "createServer"> = net,
): Promise<{ available: boolean; error?: string }> {
  return new Promise((resolve) => {
    const server = netImpl.createServer();
    server.once("error", (error) => {
      resolve({ available: false, error: error.message });
    });
    server.once("listening", () => {
      server.close(() => resolve({ available: true }));
    });
    server.listen({ host, port });
  });
}

function checkTcpConnection(
  host: string,
  port: number,
): Promise<{ success: boolean; error?: string }> {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    const timer = setTimeout(() => {
      socket.destroy();
      resolve({ success: false, error: "Connection timed out" });
    }, 5000);

    socket.once("connect", () => {
      clearTimeout(timer);
      socket.destroy();
      resolve({ success: true });
    });
    socket.once("error", (error) => {
      clearTimeout(timer);
      socket.destroy();
      resolve({ success: false, error: error.message });
    });
  });
}

// A proxy in front of the server may drop an idle WebSocket, which stopped
// the tunnel. Pings count as traffic.
export function keepSocketAlive(ws: WebSocket, intervalMs = PING_MS): void {
  const timer = setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) ws.ping();
  }, intervalMs);
  timer.unref?.();
  ws.once("close", () => clearInterval(timer));
}

export function createC2SRuntime(deps: C2SRuntimeDeps) {
  const runtimes = new Map<string, Runtime>();
  const netImpl = deps.netImpl ?? net;
  const log = deps.log;

  const statuses = () => {
    const out: Record<string, TunnelStatus> = {};
    for (const name of runtimes.keys()) out[name] = statusOf(name);
    return out;
  };
  const statusOf = (name: string): TunnelStatus =>
    runtimes.get(name)?.status || { connected: false, status: "DISCONNECTED" };
  const emit = () => deps.onStatuses(statuses());
  const setStatus = (name: string, status: TunnelStatus) => {
    const runtime = runtimes.get(name);
    if (runtime) {
      runtime.status = status;
      emit();
    }
  };
  const setError = (name: string, message: string) => {
    log(`[c2s] ${name} failed:`, message);
    setStatus(name, { connected: false, status: "ERROR", reason: message });
  };

  async function requireLink(): Promise<LinkInfo> {
    const link = await deps.getLink();
    if (!link) {
      throw new Error(
        "This device is not linked to a Termix server. Link it in Sync first.",
      );
    }
    return link;
  }

  async function relayTarget(): Promise<{
    url: string;
    headers: Record<string, string>;
    rejectUnauthorized?: boolean;
  }> {
    const link = await requireLink();
    if (!link.token) throw new Error(SESSION_EXPIRED_ERROR);
    const url = `${link.serverUrl.replace(/\/+$/, "")}${deps.relayPath}`
      .replace(/^http:/, "ws:")
      .replace(/^https:/, "wss:");
    return {
      url,
      headers: link.headers,
      ...(url.startsWith("wss:") && link.allowInvalidCertificate
        ? { rejectUnauthorized: false }
        : {}),
    };
  }

  async function openSocket(
    name: string,
  ): Promise<{ ws: WebSocket; url: string }> {
    const target = await relayTarget();
    const options = {
      headers: target.headers,
      ...(target.rejectUnauthorized === false
        ? { rejectUnauthorized: false }
        : {}),
    };
    const ws = deps.createWebSocket
      ? deps.createWebSocket(target.url, options)
      : new WebSocket(target.url, options);
    deps.attachAuth(ws, name);
    keepSocketAlive(ws);
    return { ws, url: target.url };
  }

  async function resolveSourceHost(tunnel: C2STunnel): Promise<C2STunnel> {
    const normalized = normalizeAddresses(tunnel);
    const syncId =
      typeof normalized.sourceHostSyncId === "string"
        ? normalized.sourceHostSyncId.trim()
        : "";
    if (!syncId) return normalized;

    let remoteHost: { id?: unknown; name?: string } | null = null;
    try {
      remoteHost = (await deps.linkJson(
        `/sync/v2/hosts/${encodeURIComponent(syncId)}`,
      )) as typeof remoteHost;
    } catch (error) {
      const kind = (error as { kind?: string })?.kind;
      if (kind === "signed_out") throw new Error(SESSION_EXPIRED_ERROR);
    }
    const remoteHostId = Number(remoteHost?.id);
    if (!Number.isInteger(remoteHostId) || remoteHostId < 1) {
      throw new Error(
        "The intermediate host is not on the server yet. Sync, then try again.",
      );
    }

    return {
      ...normalized,
      sourceHostId: remoteHostId,
      sourceHostSyncId: syncId,
      sourceHostName: remoteHost?.name || normalized.sourceHostName,
      endpointHost: normalized.endpointHost || remoteHost?.name,
    };
  }

  async function openRelay(
    tunnel: C2STunnel,
    targetHost: string,
    targetPort: number,
    socket: Socket,
    initialData?: Buffer,
  ): Promise<void> {
    const tunnelConfig = normalizeAddresses(tunnel);
    const name = tunnel.name || nameOf(tunnel);
    const { ws, url } = await openSocket(name);
    log(`[c2s] opening relay for ${name}`, { url, targetHost, targetPort });
    const pendingChunks: Buffer[] = [];
    let ready = false;
    let closed = false;

    const cleanup = () => {
      if (closed) return;
      closed = true;
      try {
        socket.destroy();
      } catch {
        // expected during shutdown
      }
      try {
        ws.close();
      } catch {
        // expected during shutdown
      }
    };

    const sendChunk = (chunk: Buffer) => {
      if (ready && ws.readyState === WebSocket.OPEN) ws.send(chunk);
      else pendingChunks.push(chunk);
    };

    socket.on("data", sendChunk);
    socket.on("close", cleanup);
    // One connection failing must not stop the tunnel: the listener refuses
    // new connections while the tunnel is not connected, and a browser opens
    // many at once.
    socket.on("error", (error) => {
      log(`[c2s] ${name} local socket error:`, error.message);
      cleanup();
    });
    ws.on("close", cleanup);
    ws.on("error", (error) => {
      log(`[c2s] ${name} relay error:`, error.message);
      cleanup();
    });

    ws.on("open", () => {
      ws.send(
        JSON.stringify({ type: "open", tunnelConfig, targetHost, targetPort }),
      );
    });

    ws.on("message", (data, isBinary) => {
      if (isBinary) {
        socket.write(Buffer.isBuffer(data) ? data : Buffer.from(data as never));
        return;
      }

      try {
        const message = JSON.parse(data.toString());
        if (message.type === "ready") {
          ready = true;
          if (initialData?.length) ws.send(initialData);
          while (pendingChunks.length > 0) ws.send(pendingChunks.shift()!);
        } else if (message.type === "error") {
          const relayError = normalizeError(
            message.error,
            "Relay rejected the client tunnel",
          );
          log("[c2s] relay error:", relayError);
          if (relayError === SESSION_EXPIRED_ERROR) setError(name, relayError);
          cleanup();
        }
      } catch (error) {
        log("[c2s] invalid relay message:", (error as Error).message);
        cleanup();
      }
    });
  }

  async function testRelay(
    tunnel: C2STunnel,
    targetHost?: string,
    targetPort?: number,
    runtime?: Runtime,
  ): Promise<TestResult> {
    const tunnelConfig = normalizeAddresses(tunnel);
    const name = tunnel.name || nameOf(tunnel);
    if (runtime && runtimes.get(tunnel.name as string) !== runtime) {
      return { success: false, error: "Tunnel stopped" };
    }
    const { ws } = await openSocket(name);
    if (runtime) runtime.authSocket = ws;

    return new Promise((resolve) => {
      let settled = false;
      // The relay sends its reason and then closes; keep the reason.
      let relayError: string | null = null;
      const settle = (result: TestResult) => {
        if (settled) return;
        settled = true;
        try {
          if (!runtime || !result.success) ws.close();
        } catch {
          // expected during shutdown
        }
        resolve(result);
      };

      const timer = setTimeout(
        () => settle({ success: false, error: "Tunnel test timed out" }),
        TEST_TIMEOUT_MS,
      );

      ws.on("open", () => {
        ws.send(
          JSON.stringify({
            type: "test",
            keepAlive: !!runtime,
            tunnelConfig,
            targetHost,
            targetPort,
          }),
        );
      });
      ws.on("message", (data, isBinary) => {
        if (isBinary) return;
        try {
          const message = JSON.parse(data.toString());
          if (message.type === "ready") {
            clearTimeout(timer);
            settle({ success: true });
          } else if (message.type === "error") {
            clearTimeout(timer);
            relayError = normalizeError(message.error, "Tunnel test failed");
            settle(failure(message.error, "Tunnel test failed"));
          }
        } catch (error) {
          clearTimeout(timer);
          settle(failure((error as Error).message, "Tunnel test failed"));
        }
      });
      ws.on("error", (error) => {
        clearTimeout(timer);
        settle(failure(error.message, "Tunnel test failed"));
      });
      ws.on("close", () => {
        if (runtime && runtimes.get(tunnel.name as string) === runtime) {
          setError(
            tunnel.name as string,
            relayError || "Endpoint SSH connection closed",
          );
        }
        clearTimeout(timer);
        settle({ success: false, error: "Tunnel test connection closed" });
      });
    });
  }

  async function test(tunnel: C2STunnel, index = 0): Promise<TestResult> {
    const resolved = await resolveSourceHost(tunnel);
    const mode = tunnelMode(resolved);
    const testTunnel: C2STunnel = {
      ...normalizeAddresses(resolved),
      name: `${nameOf(resolved, index)}::test`,
      mode,
    };
    const local = localAddress(testTunnel);
    const remote = remoteAddress(testTunnel);
    const sourcePort = Number(resolved.sourcePort);
    const endpointPort = Number(resolved.endpointPort);

    if (!resolved.sourceHostId) {
      return { success: false, error: "Endpoint SSH host is required" };
    }

    if (mode === "remote") {
      const localTarget = await checkTcpConnection(local, endpointPort);
      if (!localTarget.success) {
        return {
          success: false,
          error: `Local target ${local}:${endpointPort} is not reachable: ${localTarget.error}`,
        };
      }
      return testRelay(testTunnel);
    }

    if (!Number.isInteger(sourcePort) || sourcePort < 1 || sourcePort > 65535) {
      return { success: false, error: "Invalid local port" };
    }

    if (!runtimes.get(nameOf(resolved, index))) {
      const availability = await checkLocalPortAvailable(
        local,
        sourcePort,
        netImpl,
      );
      if (!availability.available) {
        return {
          success: false,
          error: `Local listener ${local}:${sourcePort} is not available: ${availability.error}`,
        };
      }
    }

    if (mode === "dynamic") return testRelay(testTunnel);

    if (!Number.isInteger(endpointPort) || endpointPort < 1) {
      return { success: false, error: "Invalid remote port" };
    }
    return testRelay(testTunnel, remote, endpointPort);
  }

  function handleDynamicConnection(tunnel: C2STunnel, socket: Socket): void {
    const name = tunnel.name || nameOf(tunnel);
    let buffer: Buffer = Buffer.alloc(0);
    let stage = "greeting";

    const fail = (code = 0x01, message = "SOCKS5 request failed") => {
      setError(name, message);
      if (!socket.destroyed) {
        socket.write(Buffer.from([0x05, code, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
        socket.destroy();
      }
    };

    const onData = (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);

      try {
        if (stage === "greeting") {
          if (buffer.length < 2) return;
          if (buffer[0] !== 0x05) {
            fail(0x01, "Invalid SOCKS5 greeting");
            return;
          }
          const methodsLength = buffer[1];
          if (buffer.length < 2 + methodsLength) return;
          socket.write(Buffer.from([0x05, 0x00]));
          buffer = buffer.subarray(2 + methodsLength);
          stage = "connect";
        }

        if (stage === "connect") {
          const target = parseSocks5Target(buffer);
          if (!target) return;

          stage = "piping";
          socket.off("data", onData);
          const remainder = buffer.subarray(target.bytesRead);
          socket.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
          openRelay(tunnel, target.host, target.port, socket, remainder).catch(
            (error: Error) => {
              const message = normalizeError(
                error.message,
                "Dynamic relay failed",
              );
              log("[c2s] dynamic relay failed:", message);
              fail(0x05, message);
            },
          );
        }
      } catch (error) {
        log("[c2s] SOCKS5 parse failed:", (error as Error).message);
        fail(0x01, (error as Error).message || "SOCKS5 parse failed");
      }
    };

    socket.on("data", onData);
    socket.on("error", () => socket.destroy());
  }

  function handleLocalConnection(tunnel: C2STunnel, socket: Socket): void {
    const name = tunnel.name || nameOf(tunnel);
    openRelay(
      tunnel,
      remoteAddress(tunnel),
      Number(tunnel.endpointPort),
      socket,
    ).catch((error: Error) => {
      const message = normalizeError(error.message, "Local relay failed");
      log("[c2s] local relay failed:", message);
      if (message === SESSION_EXPIRED_ERROR) setError(name, message);
      socket.destroy();
    });
  }

  function pauseSourceForSocket(ws: WebSocket, source?: Socket): void {
    if (!source?.pause || !source?.resume) return;
    if (ws.bufferedAmount <= WS_HIGH_WATERMARK) return;

    source.pause();
    const resumeTimer = setInterval(() => {
      if (
        ws.readyState !== WebSocket.OPEN ||
        source.destroyed ||
        ws.bufferedAmount <= WS_LOW_WATERMARK
      ) {
        clearInterval(resumeTimer);
        if (ws.readyState === WebSocket.OPEN && !source.destroyed) {
          source.resume();
        }
      }
    }, 25);
  }

  function sendRemoteMessage(
    ws: WebSocket,
    message: Record<string, unknown>,
    source?: Socket,
  ): void {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(message), (error) => {
        if (error && source?.destroy) source.destroy(error);
      });
      pauseSourceForSocket(ws, source);
    }
  }

  function writeRemoteChunk(
    target: Socket | undefined,
    chunk: Buffer,
    ws: WebSocket,
    closeTarget: () => void,
  ): void {
    if (!target || target.destroyed) return;

    if (target.writableLength > STREAM_WRITE_LIMIT) {
      closeTarget();
      return;
    }

    const canContinue = target.write(chunk);
    if (!canContinue && typeof ws.pause === "function") {
      ws.pause();
      target.once("drain", () => {
        if (
          ws.readyState === WebSocket.OPEN &&
          typeof ws.resume === "function"
        ) {
          ws.resume();
        }
      });
    }
  }

  async function startRemote(
    tunnel: C2STunnel,
    index = 0,
  ): Promise<StartResult> {
    const name = nameOf(tunnel, index);
    const tunnelConfig = normalizeAddresses(tunnel);
    const localHost = localAddress(tunnelConfig);
    const remoteHost = remoteAddress(tunnelConfig);
    const localPort = Number(tunnel.endpointPort);
    const remotePort = Number(tunnel.sourcePort);

    if (!tunnel.sourceHostId) {
      return { success: false, error: "Endpoint SSH host is required" };
    }
    if (!Number.isInteger(remotePort) || remotePort < 1 || remotePort > 65535) {
      return { success: false, error: "Invalid remote port" };
    }
    if (!Number.isInteger(localPort) || localPort < 1 || localPort > 65535) {
      return { success: false, error: "Invalid local port" };
    }

    const localTarget = await checkTcpConnection(localHost, localPort);
    if (!localTarget.success) {
      return {
        success: false,
        error: `Local target ${localHost}:${localPort} is not reachable: ${localTarget.error}`,
      };
    }

    if (runtimes.get(name)) return { success: true, tunnelName: name };

    for (const runtime of runtimes.values()) {
      if (
        runtime.mode === "remote" &&
        runtime.sourceHostId === Number(tunnel.sourceHostId) &&
        runtime.remoteAddress === remoteHost &&
        runtime.sourcePort === remotePort
      ) {
        return {
          success: false,
          error: `Another client remote tunnel already uses ${remoteHost}:${remotePort} on this endpoint`,
        };
      }
    }

    const { ws, url } = await openSocket(tunnel.name || nameOf(tunnel));
    const sockets = new Map<string, Socket>();
    let closed = false;

    const cleanup = () => {
      if (closed) return;
      closed = true;
      for (const socket of sockets.values()) socket.destroy();
      sockets.clear();
      try {
        ws.close();
      } catch {
        // expected during shutdown
      }
    };

    runtimes.set(name, {
      ws,
      sockets,
      mode: "remote",
      sourceHostId: Number(tunnel.sourceHostId),
      sourcePort: remotePort,
      bindHost: localHost,
      remoteAddress: remoteHost,
      status: { connected: false, status: "CONNECTING" },
      close: cleanup,
    });
    emit();

    return new Promise((resolve) => {
      let settled = false;
      const settle = (result: StartResult) => {
        if (settled) return;
        settled = true;
        resolve(result);
      };
      const drop = () => {
        cleanup();
        runtimes.delete(name);
        emit();
      };

      ws.on("open", () => {
        log(`[c2s] opening remote tunnel ${name}`, {
          url,
          remoteHost,
          remotePort,
          localHost,
          localPort,
        });
        ws.send(
          JSON.stringify({
            type: "open",
            tunnelConfig: { ...tunnelConfig, name, mode: "remote" },
          }),
        );
      });

      ws.on("message", (data, isBinary) => {
        if (isBinary) return;

        let message: {
          type?: string;
          error?: string;
          streamId?: string;
          data?: string;
        };
        try {
          message = JSON.parse(data.toString());
        } catch (error) {
          const text = normalizeError(
            (error as Error).message,
            "Invalid relay message",
          );
          setError(name, text);
          cleanup();
          settle(failure(text, "Invalid relay message"));
          return;
        }

        if (message.type === "ready") {
          setStatus(name, { connected: true, status: "CONNECTED" });
          settle({ success: true, tunnelName: name });
          return;
        }

        if (message.type === "error") {
          const text = normalizeError(
            message.error,
            "Relay rejected the client tunnel",
          );
          setError(name, text);
          cleanup();
          runtimes.delete(name);
          emit();
          settle(failure(text, "Relay rejected the client tunnel"));
          return;
        }

        if (message.type === "connection" && message.streamId) {
          const streamId = message.streamId;
          const socket = netImpl.createConnection(
            { host: localHost, port: localPort },
            () => {
              log(`[c2s] remote stream ${streamId} connected`, {
                name,
                localHost,
                localPort,
              });
            },
          );
          sockets.set(streamId, socket);
          socket.on("data", (chunk) => {
            sendRemoteMessage(
              ws,
              { type: "data", streamId, data: chunk.toString("base64") },
              socket,
            );
          });
          socket.on("close", () => {
            sockets.delete(streamId);
            sendRemoteMessage(ws, { type: "close", streamId });
          });
          socket.on("error", (error) => {
            log(`[c2s] remote stream ${streamId} failed:`, {
              name,
              error: error.message,
            });
            sockets.delete(streamId);
            sendRemoteMessage(ws, {
              type: "close",
              streamId,
              error: error.message,
            });
          });
          return;
        }

        if (message.type === "data" && message.streamId && message.data) {
          const streamId = message.streamId;
          const socket = sockets.get(streamId);
          writeRemoteChunk(
            socket,
            Buffer.from(message.data, "base64"),
            ws,
            () => {
              if (socket) {
                sockets.delete(streamId);
                socket.destroy();
              }
            },
          );
          return;
        }

        if (message.type === "close" && message.streamId) {
          const socket = sockets.get(message.streamId);
          if (socket) {
            sockets.delete(message.streamId);
            socket.destroy();
          }
        }
      });

      ws.on("close", () => {
        drop();
        settle({ success: false, error: "Remote tunnel relay closed" });
      });

      ws.on("error", (error) => {
        const text = normalizeError(error.message, "Relay connection failed");
        setError(name, text);
        drop();
        settle(failure(text, "Relay connection failed"));
      });
    });
  }

  async function start(tunnel: C2STunnel, index = 0): Promise<StartResult> {
    const resolved = await resolveSourceHost(tunnel);
    const mode = tunnelMode(resolved);
    const name = nameOf(resolved, index);
    const tunnelConfig: C2STunnel = {
      ...normalizeAddresses(resolved),
      sessionId: randomUUID(),
    };
    const bindHost = localAddress(tunnelConfig);
    const sourcePort = Number(resolved.sourcePort);
    log(`[c2s] starting tunnel ${name}`, {
      mode,
      bindHost,
      remoteAddress: remoteAddress(tunnelConfig),
      sourcePort,
      sourceHostId: resolved.sourceHostId,
      sourceHostSyncId: resolved.sourceHostSyncId,
      endpointPort: resolved.endpointPort,
    });

    if (mode === "remote") return startRemote(resolved, index);
    if (!resolved.sourceHostId) {
      return { success: false, error: "Endpoint SSH host is required" };
    }
    if (!Number.isInteger(sourcePort) || sourcePort < 1 || sourcePort > 65535) {
      return { success: false, error: "Invalid local port" };
    }

    if (runtimes.get(name)) return { success: true, tunnelName: name };

    for (const runtime of runtimes.values()) {
      if (
        runtime.mode !== "remote" &&
        runtime.bindHost === bindHost &&
        runtime.sourcePort === sourcePort
      ) {
        return {
          success: false,
          error: `Another client tunnel already uses ${bindHost}:${sourcePort}`,
        };
      }
    }

    const availability = await checkLocalPortAvailable(
      bindHost,
      sourcePort,
      netImpl,
    );
    if (!availability.available) {
      return {
        success: false,
        error: availability.error || "Port is already in use",
      };
    }

    const sockets = new Set<Socket>();
    const connection: C2STunnel = { ...tunnelConfig, name, mode };
    const server = netImpl.createServer((socket) => {
      if (!runtimes.get(name)?.status.connected) {
        socket.destroy();
        return;
      }
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
      if (mode === "dynamic") handleDynamicConnection(connection, socket);
      else handleLocalConnection(connection, socket);
    });

    runtimes.set(name, {
      server,
      sockets,
      bindHost,
      sourcePort,
      status: { connected: false, status: "CONNECTING" },
    });

    return new Promise((resolve) => {
      server.once("error", (error) => {
        runtimes.delete(name);
        log(`[c2s] failed to listen for ${name}:`, error.message);
        emit();
        resolve({ success: false, error: error.message });
      });
      server.listen({ host: bindHost, port: sourcePort }, () => {
        log(`[c2s] listening for ${name} on ${bindHost}:${sourcePort}`);
        setStatus(name, {
          connected: false,
          status: "CONNECTING",
          reason: "Verifying endpoint SSH connection",
        });

        const runtime = runtimes.get(name);
        void testRelay(
          connection,
          mode === "dynamic" ? undefined : remoteAddress(tunnelConfig),
          mode === "dynamic" ? undefined : Number(tunnelConfig.endpointPort),
          runtime,
        )
          .then((result) => {
            if (runtimes.get(name) !== runtime) return;
            if (result.success) {
              setStatus(name, { connected: true, status: "CONNECTED" });
            } else {
              setError(
                name,
                (result as { error?: string }).error ||
                  "Endpoint SSH connection failed",
              );
            }
          })
          .catch((error: Error) => {
            if (runtimes.get(name) === runtime) {
              setError(name, error.message || "Endpoint SSH connection failed");
            }
          });

        resolve({ success: true, tunnelName: name });
      });
    });
  }

  async function stop(name: string): Promise<{ success: true }> {
    const runtime = runtimes.get(name);
    if (!runtime) return { success: true };

    setStatus(name, { connected: false, status: "DISCONNECTING" });
    runtime.authSocket?.close();

    return new Promise((resolve) => {
      if (typeof runtime.close === "function") {
        runtime.close();
        runtimes.delete(name);
        emit();
        resolve({ success: true });
        return;
      }

      for (const socket of runtime.sockets) (socket as Socket).destroy();
      runtime.server?.close(() => {
        runtimes.delete(name);
        emit();
        resolve({ success: true });
      });
    });
  }

  function stopAll(): void {
    for (const [name, runtime] of [...runtimes.entries()]) {
      try {
        runtime.authSocket?.close();
        if (typeof runtime.close === "function") {
          runtime.close();
        } else {
          for (const socket of runtime.sockets) (socket as Socket).destroy();
          runtime.server?.close();
        }
      } catch (error) {
        log(`[c2s] failed to stop tunnel ${name}:`, (error as Error).message);
      }
      runtimes.delete(name);
    }
    emit();
  }

  async function startAutoStart(
    tunnels: C2STunnel[],
  ): Promise<{ success: boolean; started: number; errors: string[] }> {
    const errors: string[] = [];
    let started = 0;
    for (let index = 0; index < tunnels.length; index += 1) {
      const tunnel = tunnels[index];
      if (!tunnel?.autoStart) continue;
      const result = await start(tunnel, index);
      if (result.success) started += 1;
      else {
        errors.push(
          (result as { error?: string }).error ||
            "Failed to start client tunnel",
        );
      }
    }
    return { success: errors.length === 0, started, errors };
  }

  return {
    start,
    test,
    stop,
    stopAll,
    startAutoStart,
    statuses,
    /** Whether a running client tunnel already holds this local address. */
    ownsListener: (bindHost: string, port: number) =>
      [...runtimes.values()].some(
        (runtime) =>
          runtime.bindHost === bindHost && runtime.sourcePort === port,
      ),
    /** Exposed for tests. */
    openRelay,
    testRelay,
    runtimes,
  };
}

export type C2SRuntime = ReturnType<typeof createC2SRuntime>;

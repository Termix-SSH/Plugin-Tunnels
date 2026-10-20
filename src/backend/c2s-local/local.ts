import os from "node:os";
import type { Request, Response, Router } from "express";
import type { WebSocket } from "ws";
import type { PluginContext } from "@termix-ssh/plugin-sdk/backend";
import { createAuthBridge, type AuthEvent } from "./auth-bridge.js";
import { createConfigStore } from "./config-store.js";
import {
  createC2SRuntime,
  checkLocalPortAvailable,
  type C2SRuntime,
  type LinkInfo,
} from "./runtime.js";
import { failure, type C2STunnel } from "./addresses.js";

/** The relay this plugin serves on the linked server. */
export const C2S_RELAY_PATH = "/plugin-ws/tunnels/c2s/stream";

function presetDefaultName(): string {
  const date = new Date().toISOString().slice(0, 10);
  const platform =
    process.platform === "darwin"
      ? "macOS"
      : process.platform === "win32"
        ? "Windows"
        : "Linux";
  return `[${date}] ${os.hostname()} (${platform} ${os.release()})`;
}

/**
 * Client tunnels on the desktop's own computer: a local listener that relays
 * through the server this desktop is linked to. Runs only on the desktop
 * app's embedded backend. The window talks to it over /c2s-local routes and
 * one events socket; it never supplies a URL or a login for the server.
 */
export async function registerC2SLocal(
  ctx: PluginContext,
  router: Router,
): Promise<{ runtime: C2SRuntime } | null> {
  if (!ctx.desktop.local.available()) return null;

  let info: Awaited<ReturnType<typeof ctx.desktop.local.info>>;
  try {
    info = await ctx.desktop.local.info();
  } catch (error) {
    ctx.log.warn(
      `Client tunnels are off: ${error instanceof Error ? error.message : String(error)}`,
    );
    return null;
  }
  const config = createConfigStore(info.userDataDir);

  const windows = new Set<WebSocket>();
  const send = (socket: WebSocket, event: unknown) => {
    if (socket.readyState === 1) socket.send(JSON.stringify(event));
  };
  const broadcast = (event: unknown) => {
    for (const socket of windows) send(socket, event);
  };

  let latest: WebSocket | null = null;
  const auth = createAuthBridge({
    deliver: (event: AuthEvent) => {
      if (event.type === "auth-prompt") {
        if (!latest || latest.readyState !== 1) return null;
        send(latest, event);
        return latest;
      }
      broadcast(event);
      return {};
    },
  });

  const runtime = createC2SRuntime({
    getLink: async (): Promise<LinkInfo | null> =>
      (await ctx.desktop.local.info()).link,
    linkJson: (pathname) => ctx.desktop.local.linkJson(pathname),
    relayPath: C2S_RELAY_PATH,
    attachAuth: auth.attach,
    onStatuses: (statuses) => broadcast({ type: "statuses", statuses }),
    log: (message, data) =>
      ctx.log.debug(data ? `${message} ${JSON.stringify(data)}` : message),
  });
  ctx.disposables.add(() => {
    runtime.stopAll();
    auth.dispose();
    for (const socket of windows) socket.close();
    windows.clear();
  });

  ctx.ws.route("/c2s-local/events", (connection) => {
    const socket = connection.socket as WebSocket;
    windows.add(socket);
    latest = socket;
    send(socket, { type: "statuses", statuses: runtime.statuses() });
    socket.once("close", () => {
      windows.delete(socket);
      auth.dropTarget(socket);
      if (latest === socket) latest = [...windows].at(-1) ?? null;
    });
  });

  /**
   * @openapi
   * /plugin-api/tunnels/c2s-local/config:
   *   get:
   *     summary: Get this computer's client tunnels
   *     description: Desktop app only. The list kept on this computer.
   *     tags:
   *       - Tunnels
   *     responses:
   *       200:
   *         description: The client tunnels.
   */
  router.get("/c2s-local/config", (_req: Request, res: Response) => {
    res.json(config.read());
  });

  /**
   * @openapi
   * /plugin-api/tunnels/c2s-local/config:
   *   put:
   *     summary: Save this computer's client tunnels
   *     description: Desktop app only. Refuses two auto-start tunnels on one address.
   *     tags:
   *       - Tunnels
   *     responses:
   *       200:
   *         description: Saved, or a reason it was not.
   */
  router.put("/c2s-local/config", async (req: Request, res: Response) => {
    res.json(await config.save(req.body, runtime.ownsListener));
  });

  /**
   * @openapi
   * /plugin-api/tunnels/c2s-local/port-available:
   *   get:
   *     summary: Check a local port
   *     description: Desktop app only. Whether this computer can listen on the address.
   *     tags:
   *       - Tunnels
   *     responses:
   *       200:
   *         description: Whether the port is free.
   */
  router.get(
    "/c2s-local/port-available",
    async (req: Request, res: Response) => {
      const host = String(req.query.host ?? "");
      const port = Number(req.query.port);
      if (!host || !Number.isInteger(port) || port < 1 || port > 65535) {
        res.json({
          available: false,
          error: "Invalid local bind address or port",
        });
        return;
      }
      res.json(await checkLocalPortAvailable(host, port));
    },
  );

  /**
   * @openapi
   * /plugin-api/tunnels/c2s-local/statuses:
   *   get:
   *     summary: Get client tunnel statuses
   *     description: Desktop app only.
   *     tags:
   *       - Tunnels
   *     responses:
   *       200:
   *         description: Statuses keyed by tunnel name.
   */
  router.get("/c2s-local/statuses", (_req: Request, res: Response) => {
    res.json(runtime.statuses());
  });

  /**
   * @openapi
   * /plugin-api/tunnels/c2s-local/preset-default-name:
   *   get:
   *     summary: Suggest a preset name
   *     description: Desktop app only. Date, computer name and system.
   *     tags:
   *       - Tunnels
   *     responses:
   *       200:
   *         description: The name.
   */
  router.get("/c2s-local/preset-default-name", (_req, res: Response) => {
    res.json({ name: presetDefaultName() });
  });

  const guard =
    <T>(fallback: string, run: (req: Request) => Promise<T>) =>
    async (req: Request, res: Response) => {
      try {
        res.json(await run(req));
      } catch (error) {
        res.json(
          failure(error instanceof Error ? error.message : error, fallback),
        );
      }
    };

  /**
   * @openapi
   * /plugin-api/tunnels/c2s-local/start:
   *   post:
   *     summary: Start a client tunnel
   *     description: Desktop app only. Needs this computer linked to a server.
   *     tags:
   *       - Tunnels
   *     responses:
   *       200:
   *         description: The tunnel name, or the reason it did not start.
   */
  router.post(
    "/c2s-local/start",
    guard("Failed to start client tunnel", (req) =>
      runtime.start(
        req.body?.tunnel as C2STunnel,
        Number(req.body?.index) || 0,
      ),
    ),
  );

  /**
   * @openapi
   * /plugin-api/tunnels/c2s-local/test:
   *   post:
   *     summary: Test a client tunnel
   *     description: Desktop app only.
   *     tags:
   *       - Tunnels
   *     responses:
   *       200:
   *         description: Whether the tunnel works.
   */
  router.post(
    "/c2s-local/test",
    guard("Failed to test client tunnel", (req) =>
      runtime.test(req.body?.tunnel as C2STunnel, Number(req.body?.index) || 0),
    ),
  );

  /**
   * @openapi
   * /plugin-api/tunnels/c2s-local/stop:
   *   post:
   *     summary: Stop a client tunnel
   *     description: Desktop app only.
   *     tags:
   *       - Tunnels
   *     responses:
   *       200:
   *         description: Stopped.
   */
  router.post(
    "/c2s-local/stop",
    guard("Failed to stop client tunnel", (req) =>
      runtime.stop(String(req.body?.tunnelName ?? "")),
    ),
  );

  /**
   * @openapi
   * /plugin-api/tunnels/c2s-local/autostart:
   *   post:
   *     summary: Start the auto-start client tunnels
   *     description: Desktop app only. Called once after sign in.
   *     tags:
   *       - Tunnels
   *     responses:
   *       200:
   *         description: How many started and what failed.
   */
  router.post("/c2s-local/autostart", async (_req: Request, res: Response) => {
    try {
      res.json(await runtime.startAutoStart(config.read()));
    } catch (error) {
      res.json({
        success: false,
        started: 0,
        errors: [error instanceof Error ? error.message : String(error)],
      });
    }
  });

  /**
   * @openapi
   * /plugin-api/tunnels/c2s-local/auth-answer:
   *   post:
   *     summary: Answer a sign-in prompt
   *     description: Desktop app only. Answers a code or password the endpoint host asked for. A null answer cancels.
   *     tags:
   *       - Tunnels
   *     responses:
   *       200:
   *         description: Whether the prompt was still waiting.
   */
  router.post("/c2s-local/auth-answer", (req: Request, res: Response) => {
    res.json({
      accepted: auth.answer(
        String(req.body?.id ?? ""),
        req.body?.answer ?? null,
      ),
    });
  });

  return { runtime };
}

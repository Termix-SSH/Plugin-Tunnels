import { randomBytes } from "node:crypto";
import type { Request, Response, Router } from "express";
import type { Client, ClientChannel } from "ssh2";
import type { PluginContext } from "@termix-ssh/plugin-sdk/backend";
import { bridgeX11, parseDisplay, type X11Display } from "./x11.js";

export const X11_DISPLAY_KEY = "x11Display";
const MAX_APPS_PER_USER = 10;
const MAX_COMMAND = 1000;
const OUTPUT_LIMIT = 4000;
const CONNECT_TIMEOUT_MS = 30_000;

export interface X11App {
  id: string;
  hostId: number;
  hostName: string;
  command: string;
  startedAt: string;
  running: boolean;
  exitCode: number | null;
  /** The last bit of what the program printed, for errors. */
  output: string;
}

interface Running extends X11App {
  userId: string;
  stop: () => void;
}

/** Checks a command typed to run on the host. */
export function readCommand(value: unknown): string {
  const command = typeof value === "string" ? value.trim() : "";
  if (!command) throw new Error("Enter a program to run, like xclock");
  if (command.length > MAX_COMMAND) throw new Error("The command is too long");
  // eslint-disable-next-line no-control-regex
  if (/[\u0000\r\n]/.test(command)) {
    throw new Error("The command must be one line");
  }
  return command;
}

function view(app: Running): X11App {
  return {
    id: app.id,
    hostId: app.hostId,
    hostName: app.hostName,
    command: app.command,
    startedAt: app.startedAt,
    running: app.running,
    exitCode: app.exitCode,
    output: app.output,
  };
}

/**
 * Programs started on a host with X11 forwarding, so their windows open on the
 * X server the admin set. They stay up until they exit or are stopped.
 */
export function createX11Apps(ctx: PluginContext) {
  const apps = new Map<string, Running>();

  const display = async (): Promise<X11Display | null> =>
    parseDisplay(await ctx.settings.get(X11_DISPLAY_KEY));

  async function start(
    userId: string,
    hostId: number,
    command: string,
  ): Promise<X11App> {
    const target = await display();
    if (!target) {
      throw Object.assign(
        new Error("An admin has to set the X server in Settings, Tunnels"),
        { status: 409 },
      );
    }
    const mine = [...apps.values()].filter(
      (app) => app.userId === userId && app.running,
    );
    if (mine.length >= MAX_APPS_PER_USER) {
      throw Object.assign(new Error("Stop a running program first"), {
        status: 429,
      });
    }
    const host = await ctx.asUser(userId, () => ctx.hosts.get(hostId));
    if (!host)
      throw Object.assign(new Error("Host not found"), { status: 404 });

    const connection = await ctx.asUser(userId, () =>
      ctx.ssh.connect<Client>(hostId, {
        purpose: "tunnel-x11",
        profile: "forward",
        timeoutMs: CONNECT_TIMEOUT_MS,
      }),
    );
    const client = connection.client;
    const stopBridge = bridgeX11(client as never, target, (error) =>
      ctx.log.warn(
        `X11 window could not reach the X server: ${error instanceof Error ? error.message : String(error)}`,
      ),
    );

    const app: Running = {
      id: randomBytes(8).toString("hex"),
      userId,
      hostId,
      hostName: (host as { name?: string }).name || String(hostId),
      command,
      startedAt: new Date().toISOString(),
      running: true,
      exitCode: null,
      output: "",
      stop: () => {},
    };

    let channel: ClientChannel | null = null;
    const finish = () => {
      if (!app.running) return;
      app.running = false;
      stopBridge();
      connection.dispose();
    };
    app.stop = () => {
      channel?.close();
      finish();
    };
    client.once("close", finish);

    try {
      channel = await new Promise<ClientChannel>((resolve, reject) => {
        client.exec(
          command,
          { x11: { single: false, screen: target.screen } } as never,
          (err: Error | undefined, stream: ClientChannel) =>
            err ? reject(err) : resolve(stream),
        );
      });
    } catch (error) {
      finish();
      throw Object.assign(
        new Error(
          /X11/i.test(error instanceof Error ? error.message : "")
            ? "The host refused X11 forwarding. Set X11Forwarding yes in its sshd config and install xauth."
            : error instanceof Error
              ? error.message
              : "Could not start the program",
        ),
        { status: 422 },
      );
    }

    const keep = (data: Buffer) => {
      app.output = (app.output + data.toString("utf8")).slice(-OUTPUT_LIMIT);
    };
    channel.on("data", keep);
    channel.stderr.on("data", keep);
    channel.on("exit", (code: number | null) => {
      app.exitCode = typeof code === "number" ? code : null;
    });
    channel.on("close", finish);

    apps.set(app.id, app);
    return view(app);
  }

  function list(userId: string): X11App[] {
    // Finished ones stay listed so their output can be read, a few at most.
    const mine = [...apps.values()]
      .filter((app) => app.userId === userId)
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
    for (const old of mine.filter((app) => !app.running).slice(10)) {
      apps.delete(old.id);
    }
    return mine.slice(0, 20).map(view);
  }

  function stop(userId: string, id: string): boolean {
    const app = apps.get(id);
    if (!app || app.userId !== userId) return false;
    app.stop();
    apps.delete(id);
    return true;
  }

  function dispose(): void {
    for (const app of apps.values()) app.stop();
    apps.clear();
  }

  return { start, list, stop, dispose, display };
}

export type X11Apps = ReturnType<typeof createX11Apps>;

export function registerX11Routes(
  router: Router,
  ctx: PluginContext,
  x11: X11Apps,
): void {
  const userOf = () => ctx.currentActor() as string;

  /**
   * @openapi
   * /plugin-api/tunnels/x11/apps:
   *   get:
   *     summary: List X11 programs
   *     description: Programs the caller started with X11 forwarding, and whether an X server is set.
   *     tags:
   *       - Tunnels
   *     responses:
   *       200:
   *         description: The programs.
   */
  router.get("/x11/apps", async (_req: Request, res: Response) => {
    res.json({
      configured: !!(await x11.display()),
      apps: x11.list(userOf()),
    });
  });

  /**
   * @openapi
   * /plugin-api/tunnels/x11/apps:
   *   post:
   *     summary: Start a program with X11 forwarding
   *     description: Runs a command on the host over SSH with X11 forwarding, so its windows open on the X server set in Settings, Tunnels.
   *     tags:
   *       - Tunnels
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             required: [hostId, command]
   *             properties:
   *               hostId:
   *                 type: integer
   *               command:
   *                 type: string
   *     responses:
   *       200:
   *         description: Started.
   *       400:
   *         description: Bad host or command.
   *       409:
   *         description: No X server is set.
   *       422:
   *         description: The host refused.
   */
  router.post("/x11/apps", async (req: Request, res: Response) => {
    const hostId = Number(req.body?.hostId);
    if (!Number.isInteger(hostId) || hostId <= 0) {
      return res.status(400).json({ error: "Pick a host" });
    }
    let command: string;
    try {
      command = readCommand(req.body?.command);
    } catch (error) {
      return res.status(400).json({ error: (error as Error).message });
    }
    try {
      res.json(await x11.start(userOf(), hostId, command));
    } catch (error) {
      const status = (error as { status?: unknown }).status;
      res.status(typeof status === "number" ? status : 502).json({
        error: error instanceof Error ? error.message : "Could not start it",
      });
    }
  });

  /**
   * @openapi
   * /plugin-api/tunnels/x11/apps/{id}:
   *   delete:
   *     summary: Stop an X11 program
   *     tags:
   *       - Tunnels
   *     parameters:
   *       - in: path
   *         name: id
   *         required: true
   *         schema:
   *           type: string
   *     responses:
   *       200:
   *         description: Stopped.
   *       404:
   *         description: Not one of the caller's programs.
   */
  router.delete("/x11/apps/:id", (req: Request, res: Response) => {
    if (!x11.stop(userOf(), String(req.params.id))) {
      return res.status(404).json({ error: "Not found" });
    }
    res.json({ success: true });
  });
}

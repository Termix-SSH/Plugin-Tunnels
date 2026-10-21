import type { Request, Response, Router } from "express";
import type { PluginContext } from "@termix-ssh/plugin-sdk/backend";
import { GatewayError, type GatewayService } from "./service.js";

function actor(ctx: PluginContext): string {
  return ctx.currentActor() as string;
}

function intParam(value: unknown): number {
  return Number(value);
}

/** Maps a thrown error to a JSON answer. Unknown errors are not shown. */
function fail(ctx: PluginContext, res: Response, error: unknown): void {
  if (error instanceof GatewayError) {
    res.status(error.status).json({ error: error.message, ...error.extra });
    return;
  }
  ctx.log.warn(
    `Gateway request failed: ${error instanceof Error ? error.message : String(error)}`,
  );
  res.status(500).json({ error: "Something went wrong" });
}

/**
 * Mounts the gateway routes on the plugin's router, which core serves at
 * /plugin-api/tunnels with auth and the tunnels.use permission in front.
 */
export function registerGatewayRoutes(
  router: Router,
  ctx: PluginContext,
  gateways: GatewayService,
): void {
  const handler =
    (run: (req: Request, res: Response) => Promise<unknown>) =>
    async (req: Request, res: Response) => {
      try {
        await run(req, res);
      } catch (error) {
        fail(ctx, res, error);
      }
    };

  /**
   * @openapi
   * /plugin-api/tunnels/gateways:
   *   get:
   *     summary: List gateways
   *     description: Returns the caller's WireGuard gateways with their ports and live state.
   *     tags:
   *       - Tunnels
   *     responses:
   *       200:
   *         description: A list of gateways.
   */
  router.get(
    "/gateways",
    handler(async (_req, res) => {
      res.json(await gateways.list(actor(ctx)));
    }),
  );

  /**
   * @openapi
   * /plugin-api/tunnels/gateways/preflight:
   *   post:
   *     summary: Check a host for gateway use
   *     description: Reports whether a host has root or passwordless sudo, WireGuard, nftables and systemd.
   *     tags:
   *       - Tunnels
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             properties:
   *               hostId:
   *                 type: integer
   *     responses:
   *       200:
   *         description: What the host has.
   *       403:
   *         description: No edit access to the host.
   */
  router.post(
    "/gateways/preflight",
    handler(async (req, res) => {
      res.json(await gateways.preflight(intParam(req.body?.hostId)));
    }),
  );

  /**
   * @openapi
   * /plugin-api/tunnels/gateways/install:
   *   post:
   *     summary: Install WireGuard and nftables on a host
   *     description: Installs the missing packages with the host's package manager.
   *     tags:
   *       - Tunnels
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             properties:
   *               hostId:
   *                 type: integer
   *     responses:
   *       200:
   *         description: Installed.
   */
  router.post(
    "/gateways/install",
    handler(async (req, res) => {
      await gateways.installDependencies(intParam(req.body?.hostId));
      res.json({ ok: true });
    }),
  );

  /**
   * @openapi
   * /plugin-api/tunnels/gateways:
   *   post:
   *     summary: Create a gateway
   *     description: Links a private host to a public host over WireGuard and sets both up.
   *     tags:
   *       - Tunnels
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             properties:
   *               name:
   *                 type: string
   *               privateHostId:
   *                 type: integer
   *               publicHostId:
   *                 type: integer
   *               endpoint:
   *                 type: string
   *               listenPort:
   *                 type: integer
   *     responses:
   *       200:
   *         description: The new gateway.
   *       400:
   *         description: A host is not ready or the input is not valid.
   */
  router.post(
    "/gateways",
    handler(async (req, res) => {
      const body = req.body ?? {};
      const created = await gateways.create(actor(ctx), {
        name: String(body.name ?? ""),
        privateHostId: intParam(body.privateHostId),
        publicHostId: intParam(body.publicHostId),
        endpoint: String(body.endpoint ?? ""),
        listenPort:
          body.listenPort === undefined ? undefined : intParam(body.listenPort),
      });
      try {
        res.json(await gateways.apply(created.id, actor(ctx)));
      } catch (error) {
        // The gateway exists; the caller can fix the host and apply again.
        if (error instanceof GatewayError) {
          res.status(error.status).json({
            error: error.message,
            gatewayId: created.id,
            ...error.extra,
          });
          return;
        }
        throw error;
      }
    }),
  );

  /**
   * @openapi
   * /plugin-api/tunnels/gateways/{id}:
   *   get:
   *     summary: Get a gateway
   *     tags:
   *       - Tunnels
   *     parameters:
   *       - in: path
   *         name: id
   *         required: true
   *         schema:
   *           type: integer
   *     responses:
   *       200:
   *         description: The gateway.
   *       404:
   *         description: Not found.
   */
  router.get(
    "/gateways/:id",
    handler(async (req, res) => {
      res.json(await gateways.get(intParam(req.params.id), actor(ctx)));
    }),
  );

  /**
   * @openapi
   * /plugin-api/tunnels/gateways/{id}:
   *   patch:
   *     summary: Change gateway settings
   *     description: Name, public address, tunnel port and port scan settings.
   *     tags:
   *       - Tunnels
   *     parameters:
   *       - in: path
   *         name: id
   *         required: true
   *         schema:
   *           type: integer
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *     responses:
   *       200:
   *         description: The gateway.
   */
  router.patch(
    "/gateways/:id",
    handler(async (req, res) => {
      res.json(
        await gateways.update(
          intParam(req.params.id),
          actor(ctx),
          req.body ?? {},
        ),
      );
    }),
  );

  /**
   * @openapi
   * /plugin-api/tunnels/gateways/{id}:
   *   delete:
   *     summary: Remove a gateway
   *     description: Takes the tunnel and its rules off both hosts, then deletes the gateway.
   *     tags:
   *       - Tunnels
   *     parameters:
   *       - in: path
   *         name: id
   *         required: true
   *         schema:
   *           type: integer
   *     responses:
   *       200:
   *         description: Removed.
   */
  router.delete(
    "/gateways/:id",
    handler(async (req, res) => {
      await gateways.remove(intParam(req.params.id), actor(ctx));
      res.json({ ok: true });
    }),
  );

  /**
   * @openapi
   * /plugin-api/tunnels/gateways/{id}/apply:
   *   post:
   *     summary: Apply a gateway again
   *     description: Writes the tunnel config and forwarding rules to both hosts.
   *     tags:
   *       - Tunnels
   *     parameters:
   *       - in: path
   *         name: id
   *         required: true
   *         schema:
   *           type: integer
   *     responses:
   *       200:
   *         description: The gateway.
   */
  router.post(
    "/gateways/:id/apply",
    handler(async (req, res) => {
      res.json(await gateways.apply(intParam(req.params.id), actor(ctx)));
    }),
  );

  /**
   * @openapi
   * /plugin-api/tunnels/gateways/{id}/check:
   *   post:
   *     summary: Check a gateway now
   *     description: Reads the tunnel and rule state from both hosts.
   *     tags:
   *       - Tunnels
   *     parameters:
   *       - in: path
   *         name: id
   *         required: true
   *         schema:
   *           type: integer
   *     responses:
   *       200:
   *         description: The gateway with fresh state.
   */
  router.post(
    "/gateways/:id/check",
    handler(async (req, res) => {
      res.json(await gateways.check(intParam(req.params.id), actor(ctx)));
    }),
  );

  /**
   * @openapi
   * /plugin-api/tunnels/gateways/{id}/scan:
   *   post:
   *     summary: Scan for listening ports
   *     description: Looks for new listening ports on the private host and the extra scan hosts.
   *     tags:
   *       - Tunnels
   *     parameters:
   *       - in: path
   *         name: id
   *         required: true
   *         schema:
   *           type: integer
   *     responses:
   *       200:
   *         description: How many new ports were found.
   */
  router.post(
    "/gateways/:id/scan",
    handler(async (req, res) => {
      const found = await gateways.scan(intParam(req.params.id), actor(ctx));
      res.json({ found });
    }),
  );

  /**
   * @openapi
   * /plugin-api/tunnels/gateways/{id}/ports:
   *   post:
   *     summary: Add a forwarded port
   *     tags:
   *       - Tunnels
   *     parameters:
   *       - in: path
   *         name: id
   *         required: true
   *         schema:
   *           type: integer
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *     responses:
   *       200:
   *         description: The new port.
   *       409:
   *         description: The public port is taken.
   */
  router.post(
    "/gateways/:id/ports",
    handler(async (req, res) => {
      res.json(
        await gateways.addPort(
          intParam(req.params.id),
          actor(ctx),
          req.body ?? {},
        ),
      );
    }),
  );

  /**
   * @openapi
   * /plugin-api/tunnels/gateways/{id}/ports/{portId}:
   *   patch:
   *     summary: Change a forwarded port
   *     description: Also turns a port on or off.
   *     tags:
   *       - Tunnels
   *     parameters:
   *       - in: path
   *         name: id
   *         required: true
   *         schema:
   *           type: integer
   *       - in: path
   *         name: portId
   *         required: true
   *         schema:
   *           type: integer
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *     responses:
   *       200:
   *         description: The port.
   */
  router.patch(
    "/gateways/:id/ports/:portId",
    handler(async (req, res) => {
      res.json(
        await gateways.updatePort(
          intParam(req.params.id),
          intParam(req.params.portId),
          actor(ctx),
          req.body ?? {},
        ),
      );
    }),
  );

  /**
   * @openapi
   * /plugin-api/tunnels/gateways/{id}/ports/{portId}:
   *   delete:
   *     summary: Remove a forwarded port
   *     tags:
   *       - Tunnels
   *     parameters:
   *       - in: path
   *         name: id
   *         required: true
   *         schema:
   *           type: integer
   *       - in: path
   *         name: portId
   *         required: true
   *         schema:
   *           type: integer
   *     responses:
   *       200:
   *         description: Removed.
   */
  router.delete(
    "/gateways/:id/ports/:portId",
    handler(async (req, res) => {
      await gateways.removePort(
        intParam(req.params.id),
        intParam(req.params.portId),
        actor(ctx),
      );
      res.json({ ok: true });
    }),
  );
}

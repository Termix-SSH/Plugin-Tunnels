import type { Request, Response, Router } from "express";
import type { PluginContext } from "@termix-ssh/plugin-sdk/backend";
import type { TunnelConnection } from "./types.js";
import type { SavedTunnelStore } from "./saved-store.js";

const MAX_TUNNELS_PER_HOST = 100;

function validPort(value: unknown): boolean {
  return (
    Number.isInteger(value) &&
    (value as number) >= 1 &&
    (value as number) <= 65535
  );
}

/** Every item must be a server tunnel with a known mode and valid ports. */
export function validateSavedTunnels(
  value: unknown,
): value is TunnelConnection[] {
  if (!Array.isArray(value) || value.length > MAX_TUNNELS_PER_HOST) {
    return false;
  }
  return value.every((item) => {
    if (!item || typeof item !== "object") return false;
    const tunnel = item as Partial<TunnelConnection>;
    const mode = tunnel.mode ?? tunnel.tunnelType ?? "local";
    if (mode !== "local" && mode !== "remote" && mode !== "dynamic") {
      return false;
    }
    if (tunnel.scope !== undefined && tunnel.scope !== "s2s") return false;
    if (!validPort(tunnel.sourcePort)) return false;
    return mode === "dynamic" || validPort(tunnel.endpointPort);
  });
}

/**
 * Saved server tunnels per host. A user sees the lists of every host they can
 * reach and may change the list of a host they can edit.
 */
export function registerSavedTunnelRoutes(
  router: Router,
  ctx: PluginContext,
  store: SavedTunnelStore,
): void {
  /**
   * @openapi
   * /plugin-api/tunnels/saved:
   *   get:
   *     summary: List saved tunnels
   *     description: Returns the saved server tunnels of every host the caller can reach.
   *     tags:
   *       - Tunnels
   *     responses:
   *       200:
   *         description: A list of { hostId, connections }.
   *       403:
   *         description: Missing the tunnels.use permission.
   */
  router.get("/saved", async (_req: Request, res: Response) => {
    const reachable = new Set((await ctx.hosts.list()).map((host) => host.id));
    const all = await store.listAll();
    res.json(
      all
        .filter((entry) => reachable.has(entry.hostId))
        .map(({ hostId, connections }) => ({ hostId, connections })),
    );
  });

  /**
   * @openapi
   * /plugin-api/tunnels/saved/{hostId}:
   *   put:
   *     summary: Save the tunnels of a host
   *     description: Replaces the saved server tunnels of a host. An empty list removes them.
   *     tags:
   *       - Tunnels
   *     parameters:
   *       - in: path
   *         name: hostId
   *         required: true
   *         schema:
   *           type: integer
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             properties:
   *               connections:
   *                 type: array
   *                 items:
   *                   type: object
   *     responses:
   *       200:
   *         description: The saved list.
   *       400:
   *         description: A tunnel is not valid.
   *       403:
   *         description: No edit access to the host.
   */
  router.put("/saved/:hostId", async (req: Request, res: Response) => {
    const hostId = Number(req.params.hostId);
    const connections = (req.body as { connections?: unknown } | undefined)
      ?.connections;
    if (!Number.isInteger(hostId) || !validateSavedTunnels(connections)) {
      return res.status(400).json({ error: "Invalid tunnel configuration" });
    }

    const access = await ctx.hosts.checkAccess(hostId, "edit");
    const host = access.hasAccess ? await ctx.hosts.get(hostId) : null;
    if (!host) {
      return res.status(403).json({ error: "Access denied to this host" });
    }

    await store.set(hostId, host.userId, connections);
    res.json({ hostId, connections });
  });
}

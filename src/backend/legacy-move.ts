import type { PluginContext } from "@termix-ssh/plugin-sdk/backend";
import { errorMessage } from "./manager.js";
import { readTunnelConnections } from "./connections.js";
import type { SavedTunnelStore } from "./saved-store.js";

/**
 * Copies tunnels saved as host settings (before 1.2.0) into the saved tunnel
 * table, then clears the host setting. Safe to run on every start: a host
 * that already has a row is left alone and its old setting is cleared.
 *
 * Older clients (the mobile app, the CLI) still write the host setting. With
 * `overwrite`, what they wrote replaces the host's row.
 */
export async function moveLegacyTunnels(
  ctx: PluginContext,
  store: SavedTunnelStore,
  overwrite = false,
): Promise<number> {
  let moved = 0;
  let values: Array<{ hostId: number; userId: string; value: unknown }>;
  try {
    values = await ctx.settings.listHostValues("tunnelConnections");
  } catch (error) {
    ctx.log.warn(`Could not read old tunnel settings: ${errorMessage(error)}`);
    return 0;
  }

  for (const { hostId, userId, value } of values) {
    try {
      const connections = readTunnelConnections(value);
      if (connections.length === 0 || !userId) continue;
      if (overwrite || !(await store.get(hostId))) {
        await store.set(hostId, userId, connections);
        moved++;
      }
      await ctx.settings.setHost(hostId, "tunnelConnections", []);
    } catch (error) {
      ctx.log.warn(
        `Could not move tunnels of host ${hostId}: ${errorMessage(error)}`,
      );
    }
  }

  if (moved > 0) ctx.log.info(`Moved tunnels of ${moved} host(s) to the table`);
  return moved;
}

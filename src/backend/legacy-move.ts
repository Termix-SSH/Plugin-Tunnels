import type { PluginContext } from "@termix-ssh/plugin-sdk/backend";
import { errorMessage } from "./manager.js";
import { readTunnelConnections } from "./connections.js";
import type { SavedTunnelStore } from "./saved-store.js";
import type { TunnelConnection } from "./types.js";

const SETTING = "tunnelConnections";

const same = (a: TunnelConnection[] | undefined, b: TunnelConnection[]) =>
  JSON.stringify(a ?? []) === JSON.stringify(b);

/**
 * Copies tunnels saved as host settings (before 1.2.0, or by an older client,
 * or synced from a server) into the saved tunnel table. Safe to run on every
 * start: a host that already has a row is left alone.
 *
 * The host setting stays as a mirror of the table, because host settings are
 * what sync carries to a linked desktop. With `overwrite`, what the setting
 * holds replaces the host's row when it differs.
 */
export async function moveLegacyTunnels(
  ctx: PluginContext,
  store: SavedTunnelStore,
  overwrite = false,
): Promise<number> {
  let moved = 0;
  let values: Array<{ hostId: number; userId: string; value: unknown }>;
  try {
    values = await ctx.settings.listHostValues(SETTING);
  } catch (error) {
    ctx.log.warn(`Could not read old tunnel settings: ${errorMessage(error)}`);
    return 0;
  }

  for (const { hostId, userId, value } of values) {
    try {
      const connections = readTunnelConnections(value);
      if (connections.length === 0 || !userId) continue;
      const existing = await store.get(hostId);
      if (
        !existing ||
        (overwrite && !same(existing.connections, connections))
      ) {
        await store.set(hostId, userId, connections);
        moved++;
      }
    } catch (error) {
      ctx.log.warn(
        `Could not move tunnels of host ${hostId}: ${errorMessage(error)}`,
      );
    }
  }

  if (moved > 0) ctx.log.info(`Moved tunnels of ${moved} host(s) to the table`);
  return moved;
}

/** Writes a host's saved tunnels to its setting, if the setting differs. */
export async function mirrorTunnels(
  ctx: PluginContext,
  hostId: number,
  connections: TunnelConnection[],
): Promise<void> {
  try {
    const current = readTunnelConnections(
      await ctx.settings.getHost(hostId, SETTING),
    );
    if (same(current, connections)) return;
    await ctx.settings.setHost(hostId, SETTING, connections);
  } catch (error) {
    ctx.log.warn(
      `Could not mirror tunnels of host ${hostId}: ${errorMessage(error)}`,
    );
  }
}

/** Mirrors every saved list, for rows saved before the mirror existed. */
export async function mirrorAllTunnels(
  ctx: PluginContext,
  store: SavedTunnelStore,
): Promise<void> {
  for (const saved of await store.listAll()) {
    await mirrorTunnels(ctx, saved.hostId, saved.connections);
  }
}

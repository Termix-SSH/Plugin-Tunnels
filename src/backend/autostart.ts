import type { PluginContext } from "@termix-ssh/plugin-sdk/backend";
import type { TunnelManager } from "./manager.js";
import { errorMessage } from "./manager.js";
import type { SavedTunnelStore, SavedTunnels } from "./saved-store.js";
import {
  buildTunnelConfig,
  connectionToRequest,
  resolveEndpoint,
} from "./config.js";

/**
 * Starts every saved tunnel marked autoStart, across every user.
 *
 * ctx.hosts only sees the acting user's hosts, so each saved list is
 * resolved and connected as the user it belongs to.
 */
export async function startAutoStartTunnels(
  ctx: PluginContext,
  manager: TunnelManager,
  store: SavedTunnelStore,
): Promise<number> {
  let started = 0;
  let saved: SavedTunnels[];
  try {
    saved = await store.listAll();
  } catch (error) {
    ctx.log.warn(
      `Could not read saved tunnels for autostart: ${errorMessage(error)}`,
    );
    return 0;
  }

  for (const { hostId, userId, connections } of saved) {
    try {
      if (!connections.some((connection) => connection.autoStart)) continue;
      if (!(await ctx.settings.getHost<boolean>(hostId, "enableTunnel"))) {
        continue;
      }

      started += await ctx.asUser(userId, async () => {
        const host = await ctx.hosts.get(hostId);
        if (!host) return 0;
        let count = 0;
        for (const [index, connection] of connections.entries()) {
          if (!connection.autoStart) continue;
          try {
            const config = await resolveEndpoint(
              ctx,
              buildTunnelConfig(
                host,
                connectionToRequest(host, index, connection),
                userId,
              ),
            );
            await manager.start(config);
            count++;
          } catch (error) {
            ctx.log.warn(
              `Autostart tunnel ${index + 1} on host ${hostId} skipped: ${errorMessage(error)}`,
            );
          }
        }
        return count;
      });
    } catch (error) {
      ctx.log.warn(
        `Autostart failed for host ${hostId}: ${errorMessage(error)}`,
      );
    }
  }

  if (started > 0) ctx.log.info(`Started ${started} autostart tunnel(s)`);
  return started;
}

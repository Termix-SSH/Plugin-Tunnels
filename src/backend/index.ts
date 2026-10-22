import type { Router } from "express";
import type { WebSocket } from "ws";
import type { PluginContext } from "@termix-ssh/plugin-sdk/backend";
import { gatewayPorts, gateways, presets, sshTunnels } from "./tables.js";
import { createGatewayRepository } from "./gateway/repository.js";
import { createGatewayService } from "./gateway/service.js";
import { registerGatewayRoutes } from "./gateway/routes.js";
import { createPresetRepository } from "./repository.js";
import { createSavedTunnelStore } from "./saved-store.js";
import { registerSavedTunnelRoutes } from "./saved-routes.js";
import {
  mirrorAllTunnels,
  mirrorTunnels,
  moveLegacyTunnels,
} from "./legacy-move.js";
import { createTunnelManager } from "./manager.js";
import { registerTunnelRoutes } from "./routes.js";
import { createC2SRelay } from "./c2s-relay.js";
import { createTunnelsService } from "./service.js";
import { startAutoStartTunnels } from "./autostart.js";
import { registerC2SLocal } from "./c2s-local/local.js";

export type {
  TunnelsAccess,
  TunnelForwardHandle,
  TunnelForwardTarget,
} from "./service.js";

// Long enough for core's host settings migration, which runs right after
// plugins activate, to have copied old saved tunnels into host settings, which
// are then moved to the table here.
const AUTOSTART_DELAY_MS = 3000;

export async function activate(ctx: PluginContext) {
  const table = await ctx.db.define(presets);
  const repository = createPresetRepository(ctx.db, table);
  const store = createSavedTunnelStore(
    ctx.db,
    await ctx.db.define(sshTunnels),
    (hostId, connections) => mirrorTunnels(ctx, hostId, connections),
  );

  const manager = createTunnelManager(ctx);
  ctx.disposables.add(() => manager.dispose());

  const router = ctx.http.router<Router>();
  registerTunnelRoutes(router, ctx, manager, repository);
  registerSavedTunnelRoutes(router, ctx, store);

  const gatewayService = createGatewayService(
    ctx,
    createGatewayRepository(
      ctx.db,
      await ctx.db.define(gateways),
      await ctx.db.define(gatewayPorts),
    ),
  );
  registerGatewayRoutes(router, ctx, gatewayService);
  gatewayService.start();
  ctx.disposables.add(() => gatewayService.dispose());
  // Client tunnels on this computer. Only the desktop app's own backend has them.
  await registerC2SLocal(ctx, router);

  const relay = createC2SRelay(ctx);
  ctx.ws.route("/c2s/stream", (connection) =>
    relay(connection.socket as WebSocket, connection.userId),
  );

  // Older clients and linked desktops carry tunnels as a host setting. Take them from there.
  ctx.disposables.add(
    ctx.settings.onChange("tunnelConnections", () => {
      void moveLegacyTunnels(ctx, store, true);
    }),
  );

  ctx.services.provide(
    "tunnels.access",
    createTunnelsService(ctx, manager, store),
  );

  // Deferred so activation is not held up by SSH handshakes.
  const autostart = setTimeout(() => {
    void moveLegacyTunnels(ctx, store)
      .then(() => mirrorAllTunnels(ctx, store))
      .then(() => startAutoStartTunnels(ctx, manager, store));
  }, AUTOSTART_DELAY_MS);
  autostart.unref?.();
  ctx.disposables.add(() => clearTimeout(autostart));

  ctx.log.info("Tunnel routes mounted at /plugin-api/tunnels");
}

export async function deactivate() {
  // Everything above was registered through ctx and is disposed by core.
}

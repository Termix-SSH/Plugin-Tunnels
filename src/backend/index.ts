import type { Router } from "express";
import type { WebSocket } from "ws";
import type { PluginContext } from "@termix-ssh/plugin-sdk/backend";
import { presets } from "./tables.js";
import { createPresetRepository } from "./repository.js";
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
// plugins activate, to have copied the saved tunnels across on an upgrade.
const AUTOSTART_DELAY_MS = 3000;

export async function activate(ctx: PluginContext) {
  const table = await ctx.db.define(presets);
  const repository = createPresetRepository(ctx.db, table);

  const manager = createTunnelManager(ctx);
  ctx.disposables.add(() => manager.dispose());

  const router = ctx.http.router<Router>();
  registerTunnelRoutes(router, ctx, manager, repository);
  // Client tunnels on this computer. Only the desktop app's own backend has them.
  await registerC2SLocal(ctx, router);

  const relay = createC2SRelay(ctx);
  ctx.ws.route("/c2s/stream", (connection) =>
    relay(connection.socket as WebSocket, connection.userId),
  );

  ctx.services.provide("tunnels.access", createTunnelsService(ctx, manager));

  // Deferred so activation is not held up by SSH handshakes.
  const autostart = setTimeout(() => {
    void startAutoStartTunnels(ctx, manager);
  }, AUTOSTART_DELAY_MS);
  autostart.unref?.();
  ctx.disposables.add(() => clearTimeout(autostart));

  ctx.log.info("Tunnel routes mounted at /plugin-api/tunnels");
}

export async function deactivate() {
  // Everything above was registered through ctx and is disposed by core.
}

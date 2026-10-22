import type { TunnelConnectRequest, TunnelConnection } from "../shared/types";
import type { PluginHostRecord } from "@termix-ssh/plugin-sdk/frontend";
import { serverTunnelName } from "../shared/tunnel-naming";

/** Whether tunnels are turned on for a host, as its pluginSettings carry it. */
export function hostTunnelsEnabled(
  host: PluginHostRecord | null | undefined,
): boolean {
  const settings = (
    host?.pluginSettings as Record<string, Record<string, unknown>> | undefined
  )?.tunnels;
  return settings?.enableTunnel === true;
}

/** Whether the tunnels panel beside this host's terminal is on. */
export function hostTunnelsPanelEnabled(
  host: PluginHostRecord | null | undefined,
): boolean {
  const settings = (
    host?.pluginSettings as Record<string, Record<string, unknown>> | undefined
  )?.tunnels;
  return settings?.enableTunnel === true && settings.showPanel !== false;
}

export function parseConnections(value: unknown): TunnelConnection[] {
  let parsed = value;
  if (typeof parsed === "string") {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      return [];
    }
  }
  return Array.isArray(parsed) ? (parsed as TunnelConnection[]) : [];
}

export function tunnelMode(
  tunnel: Pick<TunnelConnection, "mode" | "tunnelType">,
): "local" | "remote" | "dynamic" {
  return tunnel.mode ?? tunnel.tunnelType ?? "local";
}

/** What POST /connect takes for a host's saved tunnel. */
export function connectRequestFor(
  host: {
    id: string | number;
    name?: string | null;
    username?: string | null;
    ip: string;
  },
  index: number,
  tunnel: TunnelConnection,
): TunnelConnectRequest {
  const mode = tunnelMode(tunnel);
  return {
    name: serverTunnelName(host, index, tunnel),
    sourceHostId: Number(host.id),
    tunnelIndex: index,
    scope: tunnel.scope ?? "s2s",
    mode,
    tunnelType: mode === "remote" ? "remote" : "local",
    bindHost: tunnel.bindHost,
    targetHost: tunnel.targetHost,
    endpointHost: (tunnel.endpointHost ?? "").trim(),
    sourcePort: tunnel.sourcePort,
    endpointPort: tunnel.endpointPort ?? 0,
    maxRetries: tunnel.maxRetries,
    retryInterval: tunnel.retryInterval,
    autoStart: tunnel.autoStart,
  };
}

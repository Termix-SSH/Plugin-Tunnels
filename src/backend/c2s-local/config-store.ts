import fs from "node:fs";
import path from "node:path";
import { localAddress, remoteAddress, type C2STunnel } from "./addresses.js";
import { checkLocalPortAvailable } from "./runtime.js";

/** The desktop's own client tunnel list, kept next to the app's other settings. */
export function createConfigStore(userDataDir: string) {
  const file = path.join(userDataDir, "c2s-tunnels.json");

  function read(): C2STunnel[] {
    try {
      if (!fs.existsSync(file)) return [];
      const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  /** Checks the list, then writes it. Returns the first problem found. */
  async function save(
    config: unknown,
    ownsListener: (bindHost: string, port: number) => boolean,
  ): Promise<{ success: true } | { success: false; error: string }> {
    if (!Array.isArray(config)) {
      return { success: false, error: "C2S tunnel config must be an array" };
    }
    const tunnels = config as C2STunnel[];
    const autoStartListeners = new Set<string>();
    const autoStartRemoteListeners = new Set<string>();
    for (const tunnel of tunnels) {
      if (!tunnel?.autoStart) continue;
      const mode = tunnel.mode || tunnel.tunnelType || "local";
      if (mode === "remote") {
        const sourceHostId = Number(tunnel.sourceHostId);
        const sourcePort = Number(tunnel.sourcePort);
        const remote = remoteAddress(tunnel);
        if (
          !Number.isInteger(sourceHostId) ||
          sourceHostId < 1 ||
          !Number.isInteger(sourcePort) ||
          sourcePort < 1 ||
          sourcePort > 65535
        ) {
          return {
            success: false,
            error: "Invalid remote client tunnel endpoint or port",
          };
        }
        const key = `${sourceHostId}:${remote}:${sourcePort}`;
        if (autoStartRemoteListeners.has(key)) {
          return {
            success: false,
            error: `Another auto-start client tunnel already uses remote ${key}`,
          };
        }
        autoStartRemoteListeners.add(key);
        continue;
      }

      const key = `${localAddress(tunnel)}:${Number(tunnel.sourcePort)}`;
      if (autoStartListeners.has(key)) {
        return {
          success: false,
          error: `Another auto-start client tunnel already uses ${key}`,
        };
      }
      autoStartListeners.add(key);
    }
    for (const key of autoStartListeners) {
      const split = key.lastIndexOf(":");
      const bindHost = key.slice(0, split);
      const port = Number(key.slice(split + 1));
      const result = await checkLocalPortAvailable(bindHost, port);
      if (!result.available && !ownsListener(bindHost, port)) {
        return {
          success: false,
          error: `Cannot auto-start client tunnel on ${key}: ${result.error || "port is already in use"}`,
        };
      }
    }
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(tunnels, null, 2));
      return { success: true };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  }

  return { read, save, file };
}

export type ConfigStore = ReturnType<typeof createConfigStore>;

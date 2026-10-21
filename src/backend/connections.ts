import type { TunnelConnection } from "./types.js";

/** A host's saved tunnel list, as stored or sent as JSON. */
export function readTunnelConnections(value: unknown): TunnelConnection[] {
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
